// Конфиг trigger.dev. project ref — из PLAN.md/CLAUDE.md, ключи в env
// (TRIGGER_SECRET_KEY_DEV/PROD), см. .env.example.
// ВАЖНО: боевой cron/schedules НЕ включать до фазы 4 (см. src/trigger/book-drop.ts) —
// этот конфиг обслуживает только ручной запуск таска через дашборд/CLI/mcp trigger_task.
import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: 'proj_fxjnzqesxsicrpeuepzv',
  runtime: 'node',
  dirs: ['./src/trigger'],
  retries: {
    // ретраи всего run() выключены и на уровне дефолта, и явно на таске
    // (src/trigger/book-drop.ts) — риск дублирующей реальной брони при live:true,
    // т.к. в облаке state пока MemoryStateStore (без персистентности между запусками).
    enabledInDev: false,
    default: {
      maxAttempts: 1,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  // окно наблюдения дропа ≤ 5 мин (dropWatchWindow) + запас на бронь/логи
  maxDuration: 600,
});
