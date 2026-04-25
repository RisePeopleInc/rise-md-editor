import { dialog, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface OpenedFile {
  path: string;
  content: string;
}

const FILE_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  { name: 'All Files', extensions: ['*'] },
];

export async function openFile(window: BrowserWindow): Promise<OpenedFile | null> {
  const result = await dialog.showOpenDialog(window, {
    title: 'Open File',
    properties: ['openFile'],
    filters: FILE_FILTERS,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return openPath(result.filePaths[0]!);
}

export async function openPath(filePath: string): Promise<OpenedFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  return { path: filePath, content };
}

export async function saveFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function saveFileAs(
  window: BrowserWindow,
  content: string,
  suggestedName?: string,
): Promise<{ path: string } | null> {
  const result = await dialog.showSaveDialog(window, {
    title: 'Save As',
    defaultPath: suggestedName ?? 'Untitled.md',
    filters: FILE_FILTERS,
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, content, 'utf-8');
  return { path: result.filePath };
}

export function newFile(): { path: null; content: string } {
  return { path: null, content: '' };
}

export function suggestedNameFor(filePath: string | null): string {
  if (!filePath) return 'Untitled.md';
  return path.basename(filePath);
}
