/** Original decorative artwork; deliberately excluded from the accessibility tree. */
export default function MusicArtwork() {
  return (
    <div className="music-artwork" aria-hidden="true">
      <span className="artwork-sticker">Monte le son !</span>
      <svg viewBox="0 0 480 320" fill="none" focusable="false">
        <g stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="49" y="65" width="382" height="225" rx="25" fill="var(--blue)" />
          <circle cx="204" cy="170" r="88" fill="var(--ink)" />
          <circle cx="204" cy="170" r="68" stroke="var(--paper)" strokeWidth="3" />
          <circle cx="204" cy="170" r="52" stroke="var(--paper)" strokeWidth="3" />
          <circle cx="204" cy="170" r="30" fill="var(--red)" />
          <circle cx="204" cy="170" r="5" fill="var(--paper)" stroke="none" />
          <circle cx="372" cy="102" r="17" fill="var(--yellow)" />
          <path d="M372 119v60l-46 44" />
          <path d="m317 215 17 17-22 21-17-17Z" fill="var(--paper)" />
          <rect x="74" y="252" width="34" height="17" rx="4" fill="var(--yellow)" />
          <circle cx="396" cy="258" r="9" fill="var(--red)" />
          <path d="M96 42V20l36-8v23" />
          <ellipse cx="85" cy="46" rx="12" ry="9" fill="var(--yellow)" />
          <ellipse cx="121" cy="39" rx="12" ry="9" fill="var(--yellow)" />
          <path d="m324 42 8-22m14 28 17-13M21 129l-12-9m12 34H7m442 24 17-7m-17 31 20 3" />
        </g>
      </svg>
      <span className="artwork-caption">Un vinyle. Des amis. À toi de jouer.</span>
    </div>
  );
}
