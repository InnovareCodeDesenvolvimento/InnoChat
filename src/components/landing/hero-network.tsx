"use client";

import { useEffect, useRef } from "react";

/**
 * Fundo da hero: uma rede de linhas finas azuis ligando "mensagens" (nós com balão) à "agenda" (nós
 * com calendário). Partículas viajam pelas linhas, da esquerda para a direita, como mensagens
 * chegando à agenda. Reage ao mouse (parallax leve + atração dos nós próximos). Puramente
 * decorativo: `aria-hidden`, sem foco, sem eventos próprios.
 *
 * Orçamento: canvas 2D, ~36 nós no desktop e ~12 no celular; quadros a no máximo ~30 por segundo;
 * devicePixelRatio limitado a 2; pausa fora da tela (IntersectionObserver) e com a aba oculta;
 * começa só quando o navegador está ocioso, depois do primeiro paint (não compete com o LCP, que é
 * o h1). No celular (ponteiro "coarse" ou tela estreita) não reage ao toque. Com
 * `prefers-reduced-motion` desenha um único quadro estático.
 */
type Kind = "dot" | "msg" | "cal";
type NetNode = { bx: number; by: number; x: number; y: number; depth: number; kind: Kind; pulse: number };
type Edge = { a: number; b: number };
type Particle = { edge: number; from: number; to: number; t: number; speed: number };

const LINE = "96, 165, 250";
const FRAME_MS = 1000 / 30;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distribui nós numa grade com folga aleatória (determinística) e liga os vizinhos próximos. */
export function buildNetwork(width: number, height: number, small: boolean) {
  const rand = mulberry32(20261001);
  const cell = small ? 150 : 175;
  const cols = Math.max(2, Math.round(width / cell));
  const rows = Math.max(2, Math.round(height / cell));
  const nodes: NetNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5 + (rand() - 0.5) * 0.7) / cols) * width;
      const y = ((r + 0.5 + (rand() - 0.5) * 0.7) / rows) * height;
      nodes.push({ bx: x, by: y, x, y, depth: 0.4 + rand() * 0.6, kind: "dot", pulse: 0 });
    }
  }
  // Mensagens à esquerda, agenda à direita.
  const byX = nodes.map((_, i) => i).sort((i, j) => nodes[i].bx - nodes[j].bx);
  const pick = Math.max(3, Math.round(nodes.length * 0.2));
  byX.slice(0, pick).forEach((i, k) => {
    if (k % 2 === 0) nodes[i].kind = "msg";
  });
  byX.slice(-pick).forEach((i, k) => {
    if (k % 2 === 0) nodes[i].kind = "cal";
  });

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const reach = cell * 1.65;
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => ({ j, d: Math.hypot(m.bx - n.bx, m.by - n.by) }))
      .filter((o) => o.j !== i && o.d < reach)
      .sort((p, q) => p.d - q.d)
      .slice(0, 3);
    for (const o of near) {
      const key = i < o.j ? `${i}-${o.j}` : `${o.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: i, b: o.j });
    }
  });
  return { nodes, edges };
}

function drawIcon(ctx: CanvasRenderingContext2D, kind: Kind, x: number, y: number, alpha: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = `rgba(${LINE}, ${alpha})`;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (kind === "msg") {
    ctx.beginPath();
    ctx.moveTo(-5, -4);
    ctx.lineTo(5, -4);
    ctx.quadraticCurveTo(7, -4, 7, -2);
    ctx.lineTo(7, 2);
    ctx.quadraticCurveTo(7, 4, 5, 4);
    ctx.lineTo(-1, 4);
    ctx.lineTo(-5, 7);
    ctx.lineTo(-4.4, 4);
    ctx.quadraticCurveTo(-7, 4, -7, 2);
    ctx.lineTo(-7, -2);
    ctx.quadraticCurveTo(-7, -4, -5, -4);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(-6.5, -5.5, 13, 12, 2);
    ctx.moveTo(-6.5, -1.5);
    ctx.lineTo(6.5, -1.5);
    ctx.moveTo(-3, -7.5);
    ctx.lineTo(-3, -4);
    ctx.moveTo(3, -7.5);
    ctx.lineTo(3, -4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 2.8, 0.9, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${LINE}, ${alpha})`;
    ctx.fill();
  }
  ctx.restore();
}

export function HeroNetwork() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !host || !ctx) return;

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let dpr = 1;
    let small = false;
    let net = buildNetwork(10, 10, true);
    let particles: Particle[] = [];
    const pointer = { x: 0, y: 0, active: false };
    const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
    let raf = 0;
    let last = 0;
    let onScreen = true;
    let started = false;
    let disposed = false;
    const rand = mulberry32(7);

    const spawn = (): Particle | null => {
      const msgs = net.nodes.map((n, i) => (n.kind === "msg" ? i : -1)).filter((i) => i >= 0);
      const start = msgs.length ? msgs[Math.floor(rand() * msgs.length)] : Math.floor(rand() * net.nodes.length);
      return nextHop(start, -1);
    };
    const nextHop = (from: number, prev: number): Particle | null => {
      // Prefere arestas que avançam para a direita (rumo à agenda).
      const options = net.edges
        .map((e, idx) => ({ e, idx }))
        .filter(({ e }) => e.a === from || e.b === from)
        .map(({ e, idx }) => ({ idx, to: e.a === from ? e.b : e.a }))
        .filter((o) => o.to !== prev && net.nodes[o.to].bx > net.nodes[from].bx);
      if (options.length === 0) return null;
      const o = options[Math.floor(rand() * options.length)];
      return { edge: o.idx, from, to: o.to, t: 0, speed: 0.00022 + rand() * 0.00018 };
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      small = width < 768 || window.matchMedia("(pointer: coarse)").matches;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      net = buildNetwork(width, height, small);
      particles = [];
      const count = small ? 3 : 6;
      for (let i = 0; i < count; i++) {
        const p = spawn();
        if (p) {
          p.t = rand();
          particles.push(p);
        }
      }
      draw(0);
    };

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);
      const { nodes, edges } = net;
      const useMouse = pointer.active && !small;

      // Parallax e atração: cada nó anda até o alvo (suavizado).
      parallax.x += (parallax.tx - parallax.x) * 0.06;
      parallax.y += (parallax.ty - parallax.y) * 0.06;
      for (const n of nodes) {
        let tx = n.bx + parallax.x * 14 * n.depth;
        let ty = n.by + parallax.y * 14 * n.depth;
        if (useMouse) {
          const dx = pointer.x - n.bx;
          const dy = pointer.y - n.by;
          const d = Math.hypot(dx, dy);
          if (d < 180 && d > 0.001) {
            const pull = (1 - d / 180) * 22;
            tx += (dx / d) * pull;
            ty += (dy / d) * pull;
          }
        }
        n.x += (tx - n.x) * 0.12;
        n.y += (ty - n.y) * 0.12;
        n.pulse = Math.max(0, n.pulse - dt * 0.0012);
      }

      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        let alpha = 0.16;
        if (useMouse) {
          const mx = (a.x + b.x) / 2 - pointer.x;
          const my = (a.y + b.y) / 2 - pointer.y;
          alpha += Math.max(0, 1 - Math.hypot(mx, my) / 220) * 0.22;
        }
        ctx.strokeStyle = `rgba(${LINE}, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        if (n.kind === "dot") {
          ctx.fillStyle = `rgba(${LINE}, ${0.3 + n.pulse * 0.4})`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Disco escuro para as linhas não atravessarem o ícone.
          ctx.fillStyle = "rgba(10, 18, 40, 0.92)";
          ctx.beginPath();
          ctx.arc(n.x, n.y, 13, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(${LINE}, ${0.28 + n.pulse * 0.5})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          drawIcon(ctx, n.kind, n.x, n.y, 0.62 + n.pulse * 0.38);
        }
      }

      if (dt > 0) {
        particles = particles.map((p) => {
          const t = p.t + dt * p.speed;
          if (t < 1) return { ...p, t };
          const arrived = nodes[p.to];
          arrived.pulse = 1;
          return nextHop(p.to, p.from) ?? spawn() ?? { ...p, t: 0 };
        });
      }
      for (const p of particles) {
        const a = nodes[p.from];
        const b = nodes[p.to];
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 9);
        glow.addColorStop(0, "rgba(191, 219, 254, 0.95)");
        glow.addColorStop(0.35, `rgba(${LINE}, 0.45)`);
        glow.addColorStop(1, `rgba(${LINE}, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed || !onScreen || document.hidden || reduceQuery.matches) return;
      raf = window.requestAnimationFrame(frame);
      const dt = now - last;
      if (dt < FRAME_MS) return;
      last = now;
      draw(Math.min(dt, 64));
    };
    const kick = () => {
      if (!raf && started && onScreen && !document.hidden && !reduceQuery.matches) {
        last = performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const onMove = (event: PointerEvent) => {
      if (small || event.pointerType === "touch") return;
      const rect = host.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.active = true;
      parallax.tx = (pointer.x / rect.width - 0.5) * 2;
      parallax.ty = (pointer.y / rect.height - 0.5) * 2;
    };
    const onLeave = () => {
      pointer.active = false;
      parallax.tx = 0;
      parallax.ty = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : kick());
    const onReduceChange = () => {
      stop();
      draw(0);
      kick();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen) kick();
        else stop();
      },
      { threshold: 0 },
    );
    const resizeObserver = new ResizeObserver(() => {
      if (started) resize();
    });

    // Só começa quando o navegador está ocioso (o LCP/TBT da hero vêm primeiro).
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const hasIdle = typeof w.requestIdleCallback === "function";
    const startTimer = hasIdle ? w.requestIdleCallback!(() => begin(), { timeout: 2500 }) : window.setTimeout(() => begin(), 1200);
    function begin() {
      if (disposed) return;
      started = true;
      resize();
      observer.observe(host!);
      resizeObserver.observe(host!);
      host!.addEventListener("pointermove", onMove, { passive: true });
      host!.addEventListener("pointerleave", onLeave);
      document.addEventListener("visibilitychange", onVisibility);
      reduceQuery.addEventListener("change", onReduceChange);
      kick();
    }

    return () => {
      disposed = true;
      stop();
      if (hasIdle) w.cancelIdleCallback?.(startTimer);
      else window.clearTimeout(startTimer);
      observer.disconnect();
      resizeObserver.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceQuery.removeEventListener("change", onReduceChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="hero-network"
      className="hero-network pointer-events-none absolute inset-0 -z-10 h-full w-full"
    />
  );
}
