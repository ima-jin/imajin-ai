import { BuildInfo } from './BuildInfo';

export function ImajinFooter({ className }: { className?: string }) {
  return (
    <div className={`flex flex-col items-center gap-2 ${className || ""}`}>
      <p className="text-center text-sm text-gray-500">
        Part of the{" "}
        <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a>
        {" "}sovereign network{" · "}
        <a href="https://discord.gg/kWGHUY8wbe" className="hover:underline">Discord</a>
        {" · "}
        <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
      </p>
      <BuildInfo />
    </div>
  );
}
