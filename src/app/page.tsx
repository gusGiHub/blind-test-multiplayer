import Link from "next/link";
import MusicArtwork from "./MusicArtwork";

export default function Home() {
  return (
    <main id="main-content" className="page-shell">
      <section className="hero" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">Le blind test qui fait du bruit</p>
          <h1 id="hero-title">Monte le son.<br /><span>Joue le titre.</span></h1>
          <p className="hero-description">Tes morceaux préférés, tes amis et une seule question : qui reconnaîtra le titre en premier ?</p>
          <div className="actions">
            <Link href="/create" className="btn btn-primary">Créer une partie <span aria-hidden="true">↗</span></Link>
            <Link href="/join" className="btn btn-secondary">Rejoindre une partie</Link>
          </div>
        </div>
        <MusicArtwork />
      </section>
      <section className="panel steps-panel" aria-labelledby="steps-title">
          <p className="eyebrow">Tout commence ici</p>
          <h2 id="steps-title">Trois étapes. À vous de jouer.</h2>
          <ol className="steps">
            <li><span className="step-number">01</span><div><p className="step-title">Ouvre ta salle</p><p className="step-description">Un pseudo, tes règles et ta playlist Spotify.</p></div></li>
            <li><span className="step-number">02</span><div><p className="step-title">Fais passer le code</p><p className="step-description">Tes amis te rejoignent avec le code de la partie.</p></div></li>
            <li><span className="step-number">03</span><div><p className="step-title">Tout le monde est là ?</p><p className="step-description">L’hôte donne le départ depuis le lobby.</p></div></li>
          </ol>
        </section>
      <footer className="home-footer"><span>Un pseudo pour jouer. Spotify Premium pour mettre le son.</span><span>À plusieurs, dans la même pièce. ♫</span></footer>
    </main>
  );
}
