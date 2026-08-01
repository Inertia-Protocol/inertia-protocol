type MarkProps = {
  size?: number;
  idPrefix: string;
};

export default function Mark({ size = 220, idPrefix }: MarkProps) {
  const maskId = `${idPrefix}-nslash`;
  return (
    <svg
      viewBox="0 0 300 380"
      width={(size * 300) / 380}
      height={size}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <defs>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          <rect
            x="-30"
            y="168"
            width="360"
            height="44"
            fill="black"
            transform="rotate(50 150 190)"
          />
        </mask>
      </defs>
      <text
        x="150"
        y="310"
        textAnchor="middle"
        mask={`url(#${maskId})`}
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 320,
          fontWeight: 700,
          fill: "var(--text-primary)",
        }}
      >
        I
      </text>
    </svg>
  );
}
