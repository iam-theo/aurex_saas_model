import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const NODE_BUILTIN_RE = /from\s*["']node:[a-z_]+["']|require\(["']node:[a-z_]+["']\)/;

function nodeBuiltinGuard(): Plugin {
  return {
    name: "aurex:no-node-builtins",
    transform(code, id) {
      if (id.includes("node_modules")) return null;
      const hit = code.match(NODE_BUILTIN_RE);
      if (hit) {
        this.error(
          `${id} imports Node.js builtin ${hit[0]} which the browser cannot run. ` +
            "Server-only modules (e.g. @aurex/shared/prompts, @aurex/shared/agent-prompt, node:*) " +
            "must never be reachable from client code."
        );
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        const hit = chunk.code.match(NODE_BUILTIN_RE);
        if (hit) {
          this.error(
            `${name} leaked Node.js builtin import ${hit[0]} into the browser bundle. ` +
              "Server-only modules (e.g. @aurex/shared/prompts, @aurex/shared/agent-prompt, node:*) " +
              "must never be reachable from client code."
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), nodeBuiltinGuard()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4010",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
