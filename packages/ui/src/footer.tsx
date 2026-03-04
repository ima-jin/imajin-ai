export function ImajinFooter({ className }: { className?: string }) {
  return (
    <p className={`text-center text-sm text-gray-500 ${className || ""}`}>
      Part of the{" "}
      <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a>
      {" "}sovereign network{" · "}
      <a href="https://discord.gg/kWGHUY8wbe" className="hover:underline">Discord</a>
      {" · "}
      <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
    </p>
  );
}
