export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-serif)",
        fontWeight: 900,
        fontSize: size,
        lineHeight: 1,
        display: "inline-block",
        color: "var(--text-primary)",
      }}
    >
      N
    </span>
  );
}
