import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Таймзона сервера ≠ таймзона Батуми (+04:00). Фиксируем TZ отличной от
    // локальной, чтобы тесты ловили любой код, неявно зависящий от TZ хоста.
    env: {
      TZ: 'America/New_York',
    },
  },
});
