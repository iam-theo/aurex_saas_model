import { PrismaClient } from "@prisma/client";

const DEFAULT_MODEL = "opencode/big-pickle";

const prisma = new PrismaClient();

const models = [
  {
    provider: "opencode",
    model: DEFAULT_MODEL,
    label: "Aurex BigPickle",
    isDefault: true,
  },
  {
    provider: "opencode",
    model: "opencode/deepseek-v4-flash-free",
    label: "Aurex Deepseek",
    isDefault: false,
  },
  {
    provider: "opencode",
    model: "opencode/laguna-s-2.1-free",
    label: "Aurex Laguna S2.1",
    isDefault: false,
  },
  {
    provider: "opencode",
    model: "opencode/kimi-k2.5-free",
    label: "Aurex Kimi K2.5 (vision)",
    isDefault: false,
  },
  {
    provider: "opencode",
    model: "opencode/qwen3.6-plus-free",
    label: "Aurex Qwen 3.6 (vision)",
    isDefault: false,
  },
  {
    provider: "opencode",
    model: "opencode/mimo-v2.5-free",
    label: "Aurex MiMo V2.5 (vision)",
    isDefault: false,
  },
  {
    provider: "opencode",
    model: "opencode/minimax-m3-free",
    label: "Aurex MiniMax M3 (vision)",
    isDefault: false,
  },
];

async function main() {
  for (const m of models) {
    await prisma.modelConfig.upsert({
      where: { model: m.model },
      update: { provider: m.provider, label: m.label, isDefault: m.isDefault, enabled: true },
      create: m,
    });
  }
  console.log(`Seeded ${models.length} model configs`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
