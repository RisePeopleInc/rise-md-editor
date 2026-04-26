import type { SavedAsset } from '../env';

/**
 * RAISE-11: shared helpers for processing image drops and pastes.
 *
 * Both editors (Milkdown WYSIWYG and Monaco source) want the same
 * pipeline: filter image content from a DataTransfer, save each via
 * the main-process IPC, and produce markdown image references for
 * insertion. The renderer-side glue (where to insert in the doc, what
 * to do on save) is editor-specific; this module produces the markdown
 * + path metadata that the editor's insertion code can consume.
 */

const IMAGE_MIME_PREFIX = 'image/';
const SUPPORTED_DROP_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp)$/i;

export interface ImageInsertion {
  /** Markdown to insert at the drop / paste position. */
  markdown: string;
  /** Saved asset metadata — kept around for downstream features
   *  (e.g., the click-to-view-full-size tooltip in WYSIWYG). */
  asset: SavedAsset;
}

/** Strip the extension from a basename, for use as image alt text. */
function altFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Filter a FileList for the supported image extensions. */
export function pickImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter(
    (f) =>
      f.type.startsWith(IMAGE_MIME_PREFIX) ||
      SUPPORTED_DROP_EXTENSIONS.test(f.name),
  );
}

/**
 * Drop pipeline: copy each dragged file into the markdown's assets/
 * folder. Files that fail (unsupported format, permission error)
 * are reported via showError but don't abort the others.
 */
export async function processImageDrop(
  markdownPath: string,
  files: File[],
): Promise<ImageInsertion[]> {
  const out: ImageInsertion[] = [];
  for (const file of files) {
    // Drag-drop files come from disk — webUtils.getPathForFile resolves
    // the renderer's File handle back to its absolute path so main can
    // copyFile rather than re-reading the bytes through IPC.
    const sourcePath = window.api.files.getPathForFile(file);
    if (!sourcePath) continue;
    try {
      const asset = await window.api.assets.saveDroppedImage(
        markdownPath,
        sourcePath,
      );
      out.push({
        markdown: `![${altFromName(file.name)}](${asset.relPath})`,
        asset,
      });
    } catch (err) {
      window.api.showError(
        'Could not insert image',
        `${file.name}\n\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Paste pipeline: read the clipboard image as bytes and write them out
 * with the canonical `pasted-image-{timestamp}.{ext}` name.
 */
export async function processImagePaste(
  markdownPath: string,
  item: DataTransferItem,
): Promise<ImageInsertion | null> {
  const blob = item.getAsFile();
  if (!blob) return null;
  try {
    const bytes = await blob.arrayBuffer();
    const asset = await window.api.assets.savePastedImage(
      markdownPath,
      bytes,
      item.type,
    );
    // Pasted images don't have a meaningful original name — reuse the
    // generated stem (without the .png/.jpg/etc.) as alt text.
    const stem = asset.relPath.split('/').pop() ?? '';
    return {
      markdown: `![${altFromName(stem)}](${asset.relPath})`,
      asset,
    };
  } catch (err) {
    window.api.showError(
      'Could not insert pasted image',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** True when at least one DataTransferItem in the list is an image. */
export function hasImagePasteItem(items: DataTransferItemList | null): boolean {
  if (!items) return false;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.kind === 'file' && item.type.startsWith(IMAGE_MIME_PREFIX)) {
      return true;
    }
  }
  return false;
}

/** First image DataTransferItem, or null. */
export function firstImageItem(items: DataTransferItemList | null): DataTransferItem | null {
  if (!items) return null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.kind === 'file' && item.type.startsWith(IMAGE_MIME_PREFIX)) {
      return item;
    }
  }
  return null;
}
