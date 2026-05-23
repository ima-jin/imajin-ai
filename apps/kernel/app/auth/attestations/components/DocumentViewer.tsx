'use client';

interface Props {
  assetId: string;
  mimeType: string;
  filename: string;
  hash: string;
}

export default function DocumentViewer({ assetId, mimeType, filename, hash }: Readonly<Props>) {
  const baseUrl = typeof window === 'undefined'
    ? `/media/api/assets/${assetId}`
    : `${globalThis.location.origin}/media/api/assets/${assetId}`;

  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');
  const isText = mimeType.startsWith('text/');

  return (
    <div className="space-y-3">
      <div className="bg-black/40 border border-zinc-800 rounded-lg overflow-hidden">
        {isPdf && (
          <iframe
            src={baseUrl}
            className="w-full h-96"
            title={filename}
          />
        )}
        {isImage && (
          <img
            src={baseUrl}
            alt={filename}
            className="w-full max-h-96 object-contain"
          />
        )}
        {isText && (
          <iframe
            src={baseUrl}
            className="w-full h-96 bg-black"
            title={filename}
          />
        )}
        {!isPdf && !isImage && !isText && (
          <div className="p-8 text-center text-zinc-500">
            <div className="text-3xl mb-2">📄</div>
            <div className="text-sm">{filename}</div>
            <div className="text-xs text-zinc-600 mt-1">{mimeType}</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="font-mono truncate max-w-[60%]">
          SHA-256: {hash}
        </span>
        <a
          href={`${baseUrl}?download=true`}
          className="text-amber-500 hover:text-amber-400 transition-colors"
          download
        >
          Download ↓
        </a>
      </div>
    </div>
  );
}
