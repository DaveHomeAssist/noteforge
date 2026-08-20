import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function makeSchemaV3LargeFixture() {
  const notes = Array.from({ length: 1000 }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    const previous = index > 0 ? `Large Note ${String(index - 1).padStart(4, '0')}` : 'Project Atlas';
    return {
      id: `large-${suffix}`,
      title: `Large Note ${suffix}`,
      content: `# Large Note ${suffix}\n\nDeterministic performance fixture ${index}.\n\nSee [[${previous}|previous note]].\n\n- [ ] Indexed task ${index}${index === 0 ? '\n\n![One pixel](data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=)' : ''}`,
      tags: ['large', `bucket-${index % 10}`],
      banner: index % 50 === 0
        ? { type: 'gradient', value: 'linear-gradient(135deg, #3b6ef6, #8b5cf6)', position: index % 101 }
        : null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index % 60, index % 60)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 1 + (index % 18), 12, index % 60, index % 60)).toISOString(),
      deletedAt: index > 0 && index % 20 === 0 ? '2026-08-19T00:00:00.000Z' : null,
      pinned: index % 17 === 0,
      parentId: index > 0 && index % 25 !== 0 ? `large-${String(index - 1).padStart(4, '0')}` : null,
    };
  });

  return {
    schemaVersion: 3,
    notes,
    config: {
      showGraph: false,
      themeMode: 'system',
      fontScale: 'm',
      editorWidth: 'normal',
      autosaveMs: 400,
      defaultTemplate: 'none',
      sortMode: 'updated',
      collapsed: ['large-0000', 'large-0025'],
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(
    new URL('./schema-v3-large.json', import.meta.url),
    `${JSON.stringify(makeSchemaV3LargeFixture(), null, 2)}\n`,
  );
}
