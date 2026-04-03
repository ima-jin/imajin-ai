import { BuildInfo } from './BuildInfo';

export function ImajinFooter({ className }: { className?: string }) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className || ""}`}>
      <p className="text-center text-sm text-gray-500">
        Part of the{" "}
        <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a>
        {" "}sovereign network{" · "}
        <a href="https://app.dfos.com/j/c3rff6e96e4ca9hncc43en" className="hover:underline">Community</a>
        {" · "}
        <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
        {" · "}
        <a href="https://imajin.ai/privacy" className="hover:underline">Privacy</a>
      </p>
      <BuildInfo />
    </div>
  );
}
