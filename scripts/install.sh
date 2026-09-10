#!/usr/bin/env bash
# Aurex — portable installer (full)
# Installs: system deps (optional), npm packages, postgres (docker), prisma db,
#           workspace image, web build, pm2, nginx vhost + DNS check for custom domain
# Usage:  ./scripts/install.sh [--domain aurex.example.com] [--publish-domain example.com]
#                            [--skip-workspace] [--skip-pm2] [--skip-web] [--skip-nginx]
#                            [--with-system-deps] [--yes]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---------- flags ----------
SKIP_WORKSPACE=0
SKIP_PM2=0
SKIP_WEB=0
SKIP_NGINX=0
WITH_SYSTEM_DEPS=0
ASSUME_YES=0
ARG_DOMAIN=""
ARG_PUBLISH_DOMAIN=""
for arg in "$@"; do
  case "$arg" in
    --skip-workspace) SKIP_WORKSPACE=1 ;;
    --skip-pm2) SKIP_PM2=1 ;;
    --skip-web) SKIP_WEB=1 ;;
    --skip-nginx) SKIP_NGINX=1 ;;
    --with-system-deps) WITH_SYSTEM_DEPS=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --domain=*) ARG_DOMAIN="${arg#--domain=}" ;;
    --publish-domain=*) ARG_PUBLISH_DOMAIN="${arg#--publish-domain=}" ;;
    --help|-h)
      echo "Usage: $0 [--domain aurex.example.com] [--publish-domain example.com] [--skip-workspace] [--skip-pm2] [--skip-web] [--skip-nginx] [--with-system-deps] [--yes]"
      echo "  --domain           portal FQDN (e.g. aurex.example.com). Prompts if not given."
      echo "  --publish-domain   base domain for published apps (<slug>.publish-domain). Defaults to portal's base domain."
      exit 0 ;;
    --domain) echo "--domain requires =value (e.g. --domain=aurex.example.com)" >&2; exit 1 ;;
    --publish-domain) echo "--publish-domain requires =value" >&2; exit 1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done
# support positional --domain value without = (bash loop above already handles = case; handle next arg style)
# re-parse for --domain <value> form
set -- "$@" # keep
ARGS=("$@")
for i in "${!ARGS[@]}"; do
  if [[ "${ARGS[i]}" == "--domain" && -n "${ARGS[i+1]:-}" ]]; then ARG_DOMAIN="${ARGS[i+1]}"; fi
  if [[ "${ARGS[i]}" == "--publish-domain" && -n "${ARGS[i+1]:-}" ]]; then ARG_PUBLISH_DOMAIN="${ARGS[i+1]}"; fi
done

# ---------- helpers ----------
info()  { echo -e "\033[1;34m[install]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[ok]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()   { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

is_valid_domain() {
  local d="$1"
  # RFC-ish: label 1-63 chars, dot separated, TLD >=2, no leading/trailing hyphen/dot
  [[ "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$ ]] && [[ ${#d} -le 253 ]]
}

strip_url() {
  local s="$1"
  s="${s#https://}"; s="${s#http://}"; s="${s%%/*}"; s="${s%%:*}"; echo "$s"
}

get_public_ip() {
  local ip=""
  ip=$(curl -fs --max-time 5 https://ifconfig.me 2>/dev/null || curl -fs --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")
  echo "$ip" | tr -d '[:space:]'
}

resolve_dns() {
  local d="$1" out=""
  if have dig; then out=$(dig +short A "$d" 2>/dev/null | head -1 | tr -d '[:space:]')
  elif have host; then out=$(host -t A "$d" 2>/dev/null | awk '/has address/ {print $4; exit}' | tr -d '[:space:]')
  elif have getent; then out=$(getent hosts "$d" 2>/dev/null | awk '{print $1; exit}' | tr -d '[:space:]')
  else out=$(nslookup "$d" 2>/dev/null | awk '/^Address: /{print $2; exit}' | tr -d '[:space:]' | grep -v "127\.0\.0\.1" )
  fi
  echo "$out"
}

check_dns() {
  local domain="$1" label="$2"
  local resolved ip
  resolved=$(resolve_dns "$domain")
  ip=$(get_public_ip)
  echo "  $label: $domain -> ${resolved:-<no A record>} (server public IP: ${ip:-unknown})"
  if [[ -z "$resolved" ]]; then
    warn "$domain has no A record yet — create an A record pointing to $ip (or CNAME if using tunnel)."
    if [[ "$ASSUME_YES" == 1 ]]; then return 1; fi
    echo -n "Continue anyway? [y/N] "; read -r ans || ans="n"
    [[ "$ans" =~ ^[Yy] ]] || die "fix DNS and re-run installer (or run with --yes to skip prompt)"
    return 1
  fi
  if [[ -n "$ip" && "$resolved" != "$ip" ]]; then
    warn "$domain resolves to $resolved but server IP is $ip — may be CDN/tunnel/proxy (OK if intentional)."
    if [[ "$ASSUME_YES" == 1 ]]; then return 0; fi
    echo -n "Continue? [Y/n] "; read -r ans || ans="y"
    [[ "$ans" =~ ^[Nn] ]] && die "fix DNS and re-run"
  else
    ok "$domain DNS OK ($resolved)"
  fi
  return 0
}

write_env_kv() {
  local key="$1" val="$2" file="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    # escape for sed
    local esc=$(printf '%s' "$val" | sed 's/[&/\]/\\&/g')
    sed -i "s|^${key}=.*|${key}=${esc}|" "$file"
  elif grep -q "^# *${key}=" "$file" 2>/dev/null; then
    local esc=$(printf '%s' "$val" | sed 's/[&/\]/\\&/g')
    sed -i "s|^# *${key}=.*|${key}=${esc}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

setup_nginx_vhost() {
  local portal="$1" webroot="$2"
  local avail="/etc/nginx/sites-available/aurex"
  local enabled="/etc/nginx/sites-enabled/aurex"
  local need_sudo=0
  if [[ ! -w "$(dirname "$avail")" ]]; then need_sudo=1; fi

  local conf
  conf=$(cat <<NGINX
server {
    listen 80;
    server_name ${portal};
    root ${webroot};
    index index.html;
    client_max_body_size 50m;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:4010;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
)

  info "writing nginx vhost $avail for $portal ..."
  if [[ "$need_sudo" == 1 ]]; then
    if ! sudo -n true 2>/dev/null && [[ "$ASSUME_YES" != 1 ]]; then
      warn "sudo required for nginx config — will prompt for password"
    fi
    echo "$conf" | sudo tee "$avail" >/dev/null
    sudo ln -sf "$avail" "$enabled"
    if sudo nginx -t 2>&1 | tail -5; then ok "nginx -t OK"; else warn "nginx -t failed — check $avail"; fi
    sudo systemctl reload nginx 2>&1 | tail -5 || sudo nginx -s reload 2>&1 | tail -5 || warn "nginx reload failed"
  else
    echo "$conf" > "$avail"
    ln -sf "$avail" "$enabled"
    nginx -t 2>&1 | tail -5 || warn "nginx -t failed"
    systemctl reload nginx 2>&1 | tail -5 || nginx -s reload 2>&1 | tail -5 || true
  fi
  ok "nginx vhost $portal → $webroot"
}

# ---------- 0. preflight ----------
info "Aurex installer — root: $ROOT (user: $(whoami), home: $HOME)"

if [[ ! -f "$ROOT/package.json" ]]; then die "run from aurex repo root (package.json not found)"; fi

# node >=20
if have node; then
  NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
  if [[ "$NODE_MAJOR" -lt 20 ]]; then
    warn "node $(node -v) < 20 — please upgrade to 20+ (24 recommended)"
    if [[ "$WITH_SYSTEM_DEPS" == 1 ]]; then
      info "installing nodejs 20 via nodesource..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    else
      die "node 20+ required. Re-run with --with-system-deps to auto-install, or install manually."
    fi
  else ok "node $(node -v)"; fi
else
  warn "node not found"
  if [[ "$WITH_SYSTEM_DEPS" == 1 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else die "install node 20+ first (or run with --with-system-deps)"; fi
fi

if have docker; then ok "docker $(docker --version)"; else
  warn "docker not found"
  if [[ "$WITH_SYSTEM_DEPS" == 1 ]]; then
    sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
    sudo usermod -aG docker "$USER" || true
    warn "added $USER to docker group — re-login required for docker without sudo"
  else die "install docker first (or run with --with-system-deps)"; fi
fi

if have redis-cli && redis-cli ping 2>/dev/null | grep -q PONG; then ok "redis $(redis-cli info server 2>/dev/null | grep redis_version | head -1)";
else
  warn "redis not reachable on 6379"
  if [[ "$WITH_SYSTEM_DEPS" == 1 ]]; then
    sudo apt-get update && sudo apt-get install -y redis-server
    sudo systemctl enable --now redis-server 2>/dev/null || sudo systemctl enable --now redis 2>/dev/null || true
    sleep 1
    redis-cli ping || warn "redis still not reachable — check systemctl status redis-server"
  else
    warn "install/start redis-server (sudo apt install redis-server && sudo systemctl enable --now redis-server) or set REDIS_URL in .env"
  fi
fi

have pm2 && ok "pm2 $(pm2 --version 2>/dev/null || echo ok)" || warn "pm2 not found — will install via npm if needed"
have nginx && ok "nginx $(nginx -v 2>&1)" || info "nginx not found — web will run via vite dev server (install nginx for prod: sudo apt install nginx)"

# ---------- 1. .env ----------
if [[ ! -f "$ROOT/.env" ]]; then
  if [[ -f "$ROOT/.env.example" ]]; then
    info "creating .env from .env.example..."
    cp "$ROOT/.env.example" "$ROOT/.env"
    SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
    if grep -q "SESSION_SECRET" "$ROOT/.env"; then sed -i "s|^#*SESSION_SECRET.*|SESSION_SECRET=$SECRET|" "$ROOT/.env"; else echo "SESSION_SECRET=$SECRET" >> "$ROOT/.env"; fi
    IKEY="aurex-$(openssl rand -hex 16 2>/dev/null || echo $RANDOM$RANDOM)"
    if grep -q "AUREX_INTERNAL_KEY" "$ROOT/.env"; then sed -i "s|^#*AUREX_INTERNAL_KEY.*|AUREX_INTERNAL_KEY=$IKEY|" "$ROOT/.env"; else echo "AUREX_INTERNAL_KEY=$IKEY" >> "$ROOT/.env"; fi
    warn ".env created — continuing with defaults (edit later for OAuth/keys)"
  else
    cat > "$ROOT/.env" <<EOF
DATABASE_URL=postgresql://aurex:aurex@localhost:5435/aurex?schema=public
REDIS_URL=redis://localhost:6379
API_PORT=4010
WORKSPACE_IMAGE=aurex-workspace:latest
DEFAULT_MODEL=opencode/big-pickle
RUN_TIMEOUT_MS=600000
EOF
  fi
else ok ".env exists"; fi

# ---------- 1.5 Domain configuration (portal + publish) ----------
# Resolve portal domain: CLI --domain > $AUREX_PUBLIC_BASE_URL in .env > prompt
PORTAL_DOMAIN=""
if [[ -n "$ARG_DOMAIN" ]]; then
  PORTAL_DOMAIN=$(strip_url "$ARG_DOMAIN")
elif grep -q "^AUREX_PUBLIC_BASE_URL=" "$ROOT/.env" 2>/dev/null; then
  _u=$(grep "^AUREX_PUBLIC_BASE_URL=" "$ROOT/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)
  if [[ -n "$_u" ]]; then PORTAL_DOMAIN=$(strip_url "$_u"); fi
fi
# Also check env var
if [[ -z "$PORTAL_DOMAIN" && -n "${AUREX_PUBLIC_BASE_URL:-}" ]]; then PORTAL_DOMAIN=$(strip_url "$AUREX_PUBLIC_BASE_URL"); fi
if [[ -z "$PORTAL_DOMAIN" && -n "${AUREX_DOMAIN:-}" ]]; then PORTAL_DOMAIN=$(strip_url "$AUREX_DOMAIN"); fi

if [[ -z "$PORTAL_DOMAIN" ]]; then
  if [[ "$ASSUME_YES" == 1 ]]; then
    PORTAL_DOMAIN=""
    warn "no --domain given and --yes set — skipping portal domain setup (will use localhost)"
  else
    echo ""
    echo "Domain setup — this will configure nginx + .env for your portal."
    echo "Enter the portal FQDN users will visit (e.g. aurex.example.com)"
    echo "Leave empty to skip (localhost-only install)."
    echo -n "Portal domain: "
    read -r PORTAL_DOMAIN || PORTAL_DOMAIN=""
    PORTAL_DOMAIN=$(strip_url "$PORTAL_DOMAIN")
    if [[ -n "$PORTAL_DOMAIN" && ! $(is_valid_domain "$PORTAL_DOMAIN" && echo ok) ]]; then
      warn "invalid domain: $PORTAL_DOMAIN"
      echo -n "Try again (or leave empty to skip): "; read -r PORTAL_DOMAIN || PORTAL_DOMAIN=""
      PORTAL_DOMAIN=$(strip_url "$PORTAL_DOMAIN")
    fi
  fi
fi

if [[ -n "$PORTAL_DOMAIN" ]]; then
  if ! is_valid_domain "$PORTAL_DOMAIN"; then die "invalid domain: $PORTAL_DOMAIN (expected e.g. aurex.example.com)"
  fi
  ok "portal domain: $PORTAL_DOMAIN"

  # Derive publish base domain: CLI --publish-domain > env > prompt > portal's base
  PUBLISH_DOMAIN=""
  if [[ -n "$ARG_PUBLISH_DOMAIN" ]]; then PUBLISH_DOMAIN=$(strip_url "$ARG_PUBLISH_DOMAIN")
  elif grep -q "^AUREX_PUBLISH_DOMAIN=" "$ROOT/.env" 2>/dev/null; then
    PUBLISH_DOMAIN=$(grep "^AUREX_PUBLISH_DOMAIN=" "$ROOT/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)
  fi
  if [[ -z "$PUBLISH_DOMAIN" && -n "${AUREX_PUBLISH_DOMAIN:-}" ]]; then PUBLISH_DOMAIN=$(strip_url "$AUREX_PUBLISH_DOMAIN"); fi

  if [[ -z "$PUBLISH_DOMAIN" ]]; then
    # default: base of portal domain (last 2 labels) unless portal is already 2 labels
    IFS='.' read -ra PARTS <<< "$PORTAL_DOMAIN"
    if [[ ${#PARTS[@]} -ge 3 ]]; then PUBLISH_DOMAIN="${PARTS[-2]}.${PARTS[-1]}"
    else PUBLISH_DOMAIN="$PORTAL_DOMAIN"; fi
    if [[ "$ASSUME_YES" != 1 ]]; then
      echo ""
      echo "Published apps will be at <slug>.${PUBLISH_DOMAIN} (e.g. myapp.${PUBLISH_DOMAIN})"
      echo -n "Publish base domain [${PUBLISH_DOMAIN}]: "
      read -r tmp || tmp=""
      tmp=$(strip_url "$tmp")
      if [[ -n "$tmp" ]]; then PUBLISH_DOMAIN="$tmp"; fi
    fi
  fi
  PUBLISH_DOMAIN=$(strip_url "$PUBLISH_DOMAIN")
  if ! is_valid_domain "$PUBLISH_DOMAIN"; then warn "invalid publish domain $PUBLISH_DOMAIN — using $PORTAL_DOMAIN"; PUBLISH_DOMAIN="$PORTAL_DOMAIN"; fi
  ok "publish domain: $PUBLISH_DOMAIN (*.$PUBLISH_DOMAIN)"

  # Write .env
  PUBLIC_URL="https://${PORTAL_DOMAIN}"
  write_env_kv "AUREX_PUBLIC_BASE_URL" "$PUBLIC_URL" "$ROOT/.env"
  write_env_kv "AUREX_PUBLISH_DOMAIN" "$PUBLISH_DOMAIN" "$ROOT/.env"
  # Allowed origins: portal + localhost dev
  ALLOWED="https://${PORTAL_DOMAIN},http://localhost:5173"
  if grep -q "^AUREX_ALLOWED_ORIGINS=" "$ROOT/.env"; then
    cur=$(grep "^AUREX_ALLOWED_ORIGINS=" "$ROOT/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)
    if [[ -z "$cur" || "$cur" == *"example.com"* ]]; then write_env_kv "AUREX_ALLOWED_ORIGINS" "$ALLOWED" "$ROOT/.env"; fi
  else
    write_env_kv "AUREX_ALLOWED_ORIGINS" "$ALLOWED" "$ROOT/.env"
  fi
  ok ".env updated: AUREX_PUBLIC_BASE_URL=$PUBLIC_URL, AUREX_PUBLISH_DOMAIN=$PUBLISH_DOMAIN"

  # Frontend env for Vite build (VITE_PUBLISH_DOMAIN)
  if [[ -d "$ROOT/apps/web" ]]; then
    # write apps/web/.env so Vite picks it up at build time
    WEB_ENV="$ROOT/apps/web/.env"
    # keep existing vars if present
    touch "$WEB_ENV"
    write_env_kv "VITE_PUBLISH_DOMAIN" "$PUBLISH_DOMAIN" "$WEB_ENV"
    write_env_kv "VITE_PUBLIC_BASE_URL" "$PUBLIC_URL" "$WEB_ENV"
    ok "apps/web/.env updated (VITE_PUBLISH_DOMAIN)"
  fi

  # DNS checks (portal + wildcard-ish sample)
  if [[ "$SKIP_NGINX" != 1 ]]; then
    echo ""
    info "checking DNS for $PORTAL_DOMAIN and publish domain..."
    check_dns "$PORTAL_DOMAIN" "portal" || true
    # Check a sample subdomain + root publish domain (wildcard not resolvable, but root should)
    SAMPLE="test.${PUBLISH_DOMAIN}"
    # Only check publish root, not sample (sample would need wildcard). Check root.
    check_dns "$PUBLISH_DOMAIN" "publish base" || true
    echo "  tip: for wildcard publishes, create DNS A record '*'.$PUBLISH_DOMAIN → server IP or use cloudflared tunnel."
  fi
else
  info "skipping domain setup (no portal domain given)"
fi

# ---------- 2. npm packages ----------
info "installing npm packages (workspaces)..."
npm install
ok "npm install done"

# ---------- 3. postgres (docker) ----------
info "starting postgres (docker compose)..."
if have docker; then
  if ! docker ps >/dev/null 2>&1; then
    if docker ps 2>&1 | grep -q "permission denied"; then
      warn "docker permission denied — trying with sudo"
      sudo docker compose up -d postgres || docker compose up -d postgres
    else
      sudo systemctl start docker 2>/dev/null || true
      docker compose up -d postgres
    fi
  else
    docker compose up -d postgres
  fi
  info "waiting for postgres healthy..."
  for i in $(seq 1 30); do
    if docker inspect --format='{{.State.Health.Status}}' aurex-postgres 2>/dev/null | grep -q healthy; then ok "postgres healthy"; break; fi
    if [[ $i -eq 30 ]]; then warn "postgres not healthy after 30s — check docker compose ps / logs"; fi
    sleep 1
  done
else warn "docker missing — skipping postgres start"; fi

# ---------- 4. prisma db push + seed ----------
info "pushing prisma schema..."
npx prisma db push --schema packages/db/prisma/schema.prisma --accept-data-loss 2>&1 | tail -20 || warn "prisma db push failed"
ok "prisma push done"

info "seeding default models..."
npm run db:seed --workspace @aurex/db 2>&1 | tail -20 || warn "db:seed failed (may already be seeded)"

# ---------- 5. workspace image ----------
if [[ "$SKIP_WORKSPACE" == 1 ]]; then info "skipping workspace image build (--skip-workspace)"
else
  if docker images --format '{{.Repository}}:{{.Tag}}' | grep -q "aurex-workspace:latest"; then
    if [[ "$ASSUME_YES" == 1 ]]; then REBUILD=1; else
      echo -n "Rebuild workspace image? [Y/n] (auto-yes in 3s) "; read -t 3 ans || ans="y"
      [[ "$ans" =~ ^[Nn] ]] && REBUILD=0 || REBUILD=1
    fi
    if [[ "$REBUILD" == 1 ]]; then
      info "building aurex-workspace:latest (this takes 5-15 min, cached layers)..."
      npm run workspace:build || warn "workspace build failed — retry: npm run workspace:build"
    else info "skipping rebuild"; fi
  else
    info "building aurex-workspace:latest (this takes 5-15 min, cached layers)..."
    npm run workspace:build || warn "workspace build failed — retry: npm run workspace:build"
  fi
fi

# ---------- 6. web build + nginx ----------
WEBROOT_BASE="${AUREX_WEBROOT:-/var/www/html}"
if grep -q "^AUREX_WEBROOT=" "$ROOT/.env" 2>/dev/null; then
  WEBROOT_BASE="$(grep "^AUREX_WEBROOT=" "$ROOT/.env" | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)"
fi
WEBROOT="${WEBROOT_BASE%/}/aurex"

if [[ "$SKIP_WEB" == 1 ]]; then info "skipping web build (--skip-web)";
else
  info "building web frontend..."
  npm run build --workspace @aurex/web 2>&1 | tail -30 || warn "web build failed"
  if [[ -d "$ROOT/apps/web/dist" ]]; then
    info "publishing web build to $WEBROOT ..."
    if [[ -w "$(dirname "$WEBROOT")" ]] 2>/dev/null; then
      mkdir -p "$WEBROOT" && rm -f "$WEBROOT"/assets/* 2>/dev/null || true
      cp "$ROOT/apps/web/dist/index.html" "$WEBROOT/" 2>/dev/null && cp -r "$ROOT/apps/web/dist/assets" "$WEBROOT/" 2>/dev/null && ok "web published to $WEBROOT" || warn "copy failed"
    elif sudo -n true 2>/dev/null || have sudo; then
      sudo mkdir -p "$WEBROOT" && sudo rm -f "$WEBROOT"/assets/* 2>/dev/null || true
      sudo cp "$ROOT/apps/web/dist/index.html" "$WEBROOT/" && sudo cp -r "$ROOT/apps/web/dist/assets" "$WEBROOT/" && ok "web published to $WEBROOT (via sudo)" || warn "sudo copy failed"
    else info "web build at apps/web/dist — publish manually: sudo mkdir -p $WEBROOT && sudo cp apps/web/dist/index.html $WEBROOT/ && sudo cp -r apps/web/dist/assets $WEBROOT/"; fi
  fi
fi

# Nginx vhost for portal domain
if [[ -n "${PORTAL_DOMAIN:-}" && "$SKIP_NGINX" != 1 && "$SKIP_WEB" != 1 ]]; then
  if have nginx; then
    setup_nginx_vhost "$PORTAL_DOMAIN" "$WEBROOT"
  else
    warn "nginx not installed — skipping vhost for $PORTAL_DOMAIN (install: sudo apt install nginx)"
    if [[ "$WITH_SYSTEM_DEPS" == 1 ]]; then
      sudo apt-get update && sudo apt-get install -y nginx
      setup_nginx_vhost "$PORTAL_DOMAIN" "$WEBROOT"
    fi
  fi
elif [[ -n "${PORTAL_DOMAIN:-}" && "$SKIP_NGINX" == 1 ]]; then
  info "skipping nginx vhost (--skip-nginx)"
fi

# ---------- 7. pm2 ----------
if [[ "$SKIP_PM2" == 1 ]]; then info "skipping pm2 start (--skip-pm2)";
else
  if ! have pm2; then info "installing pm2..."; npm install -g pm2 2>&1 | tail -5 || sudo npm install -g pm2 2>&1 | tail -5 || warn "pm2 install failed"; fi
  if have pm2; then
    info "starting services via pm2 (ecosystem.config.cjs)..."
    pm2 start ecosystem.config.cjs 2>&1 | tail -20 || pm2 restart ecosystem.config.cjs --update-env 2>&1 | tail -20 || warn "pm2 start failed"
    pm2 save 2>&1 | tail -5 || true
    pm2 ls 2>&1 | tail -20 || true
    echo ""
    info "to enable autostart on reboot: pm2 startup (then run printed sudo command)"
  fi
fi

# ---------- 8. verify ----------
echo ""
info "verifying..."
curl -s http://localhost:4010/api/health 2>&1 | head -5 && ok "api health ok" || warn "api not yet reachable — check pm2 logs aurex-api"
if [[ -n "${PORTAL_DOMAIN:-}" ]]; then
  echo ""
  info "checking portal via domain..."
  curl -s -o /dev/null -w "  http://%{http_code} %{url_effective}\n" "http://${PORTAL_DOMAIN}/" 2>&1 | head -5 || true
  # local nginx check
  curl -s -H "Host: ${PORTAL_DOMAIN}" http://127.0.0.1/ 2>&1 | head -c 200 | tr -d '\0' | head -5 || true
fi
echo ""
ok "install complete!"
echo ""
if [[ -n "${PORTAL_DOMAIN:-}" ]]; then
  echo "  Portal: https://${PORTAL_DOMAIN}  (http until TLS configured)"
  echo "  Publish: https://<slug>.${PUBLISH_DOMAIN:-$PORTAL_DOMAIN}"
  echo "  API:    http://localhost:4010/api/health  +  https://${PORTAL_DOMAIN}/api/health"
else
  echo "  API:    http://localhost:4010/api/health"
  echo "  Web:    http://localhost:5173 (dev) or http://localhost/ (nginx)"
fi
echo "  Logs:   pm2 logs aurex-api aurex-worker --lines 50"
echo "  Restart: pm2 restart aurex-api aurex-worker --update-env"
echo ""
if [[ -n "${PORTAL_DOMAIN:-}" ]]; then
  echo "  TLS (recommended): sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d ${PORTAL_DOMAIN}"
  if [[ "${PUBLISH_DOMAIN:-}" != "${PORTAL_DOMAIN:-}" ]]; then
    echo "                   sudo certbot --nginx -d '*.${PUBLISH_DOMAIN}' -d ${PUBLISH_DOMAIN}  # requires DNS plugin"
  fi
  echo "  DNS: ensure A record ${PORTAL_DOMAIN} → $(get_public_ip) and wildcard *.${PUBLISH_DOMAIN} if using publishes"
fi
echo ""
warn "Edit .env for OPENROUTER_API_KEY / GOOGLE_* if needed, then: pm2 restart aurex-api aurex-worker --update-env"
