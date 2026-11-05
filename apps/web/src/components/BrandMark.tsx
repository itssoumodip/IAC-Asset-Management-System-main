export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 bg-white items-center justify-center rounded-[10px] -mr-1 p-0"
      aria-hidden="true"
    >
      <img src="/logo.png" height={size} width={size} alt="" className="rounded-[6px]" />
    </span>
  );
}
