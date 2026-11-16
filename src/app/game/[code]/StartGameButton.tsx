'use client'

interface StartGameButtonProps {
    onStart: () => void;
    disabled: boolean;
    pending: boolean;
}

export default function StartGameButton({ onStart, disabled, pending }: StartGameButtonProps) {
    return (
        <button
            onClick={onStart}
            disabled={disabled}
            className="btn btn-primary btn-full"
        >
            {pending ? "Démarrage..." : "Démarrer la partie"}
        </button>
    );
}