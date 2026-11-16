'use client';
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function CurrentGameLink() {
    const pathname = usePathname();
    const [room, setRoom] = useState<{ code: string; href: string } | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/spotify/status", { cache: "no-store", signal: controller.signal })
            .then(async response => { if (!response.ok) throw Error(); return response.json(); })
            .then(data => { if (!controller.signal.aborted) setRoom(data.currentGame ?? null); })
            .catch(() => { if (!controller.signal.aborted) setRoom(null); });
        return () => controller.abort();
    }, [pathname]);
    return room ? <Link className="nav-button nav-button--room" href={room.href}><span aria-hidden="true">↩</span> Retour à ma partie <span className="nav-room-code">{room.code}</span></Link> : null;
}
