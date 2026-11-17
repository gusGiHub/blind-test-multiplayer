import Link from "next/link";
import MusicArtwork from "./MusicArtwork";

export default function Home() {
  return (
    <main id="main-content" className="page-shell">
      <section className="hero" aria-labelledby="hero-title">
        <div>
          <h1 id="hero-title">Blind test<br /><span>entre amis.</span></h1>
          <p className="hero-description">Choisis une playlist Spotify et invite tes amis.</p>
          <div className="actions">
            <Link href="/create" className="btn btn-primary">Créer une partie <span aria-hidden="true">↗</span></Link>
            <Link href="/join" className="btn btn-secondary">Rejoindre une partie</Link>
          </div>
        </div>
        <MusicArtwork />
      </section>
      <footer className="home-footer"><span>Spotify Premium nécessaire pour l’hôte.</span><span>Les joueurs écoutent dans la même pièce.</span></footer>
    </main>
  );
}
