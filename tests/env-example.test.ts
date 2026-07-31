// Регрессия на дрейф .env.example: каждая переменная окружения, которую код
// реально читает, должна быть в примере — хотя бы закомментированной строкой
// с пояснением.
//
// Зачем тест, а не «не забыть»: почти все переменные этого проекта необязательны
// по коду и их отсутствие НЕ роняет процесс, а тихо выключает функцию
// (BOT_DEBUG — диагностику, TRIGGER_SECRET_KEY — напоминания). Такое не находится
// при запуске: находится через месяц, когда напоминание не пришло. Единственный
// способ узнать о переменной — прочитать её в .env.example.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Имена в комментариях (пояснения, ссылки на доки) — не обращения к env. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Имена из `process.env.X`, `process.env['X']` и `env['X']` (последнее — стиль
 * модулей, которым окружение передают параметром: src/bot/reminder.ts,
 * src/core/profiles.ts).
 */
function envNamesUsedIn(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const names = new Set<string>();
  for (const m of src.matchAll(/(?:process\.)?env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g)) {
    names.add(m[1] ?? m[2]!);
  }
  return [...names];
}

/**
 * Имена из .env.example, включая закомментированные (`# BOT_DEBUG=`):
 * задокументировать переменную и включить её — разные вещи, тесту важно первое.
 */
function documentedNames(): Set<string> {
  const text = readFileSync(join(root, '.env.example'), 'utf8');
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/gm)) names.add(m[1]!);
  return names;
}

/**
 * Профильные переменные мультипрофилей собираются из шаблона
 * `PROFILE_<K>_NAME` под конкретный ключ K (src/core/profiles.ts), поэтому
 * буквального имени в коде нет и быть не может — в примере они показаны
 * на образце ANNA.
 */
const TEMPLATE_PREFIX = 'PROFILE_';

describe('.env.example не отстаёт от кода', () => {
  const files = [...tsFiles(join(root, 'src')), ...tsFiles(join(root, 'scripts')), join(root, 'trigger.config.ts')];

  it('обход исходников действительно что-то нашёл', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap(envNamesUsedIn)).toContain('SUPABASE_URL');
  });

  it('каждая читаемая кодом переменная описана в .env.example', () => {
    const documented = documentedNames();
    const missing = new Map<string, string[]>();

    for (const file of files) {
      for (const name of envNamesUsedIn(file)) {
        if (documented.has(name) || name.startsWith(TEMPLATE_PREFIX)) continue;
        missing.set(name, [...(missing.get(name) ?? []), file.slice(root.length + 1)]);
      }
    }

    // Сообщение об ошибке сразу говорит, что и куда дописать.
    expect(
      [...missing].map(([name, where]) => `${name} (читается в ${where.join(', ')})`),
      'переменные читаются кодом, но не описаны в .env.example',
    ).toEqual([]);
  });
});
