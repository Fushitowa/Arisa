import { useEffect, useRef } from 'react'

/**
 * VoiceOrb — canvas-based animated orb for Arisa's voice mode.
 *
 * Props:
 *   state    — 'idle' | 'listening' | 'thinking' | 'speaking'
 *   analyser — Web Audio API AnalyserNode (mic or speaker), or null
 */

const PALETTE = {
  idle:      { core: '#a28cff', edge: '#5c3fbf', glow: 'rgba(162,140,255,0.22)' },
  listening: { core: '#5deef5', edge: '#0ea5e9', glow: 'rgba(93,238,245,0.28)'  },
  thinking:  { core: '#e879f9', edge: '#9333ea', glow: 'rgba(232,121,249,0.25)' },
  speaking:  { core: '#6ee7b7', edge: '#10b981', glow: 'rgba(110,231,183,0.25)' },
}

function makeRadial(ctx, cx, cy, r, inner, outer) {
  const g = ctx.createRadialGradient(cx - r * 0.24, cy - r * 0.28, r * 0.05, cx, cy, r)
  g.addColorStop(0, inner)
  g.addColorStop(1, outer)
  return g
}

function makeGlow(ctx, cx, cy, r, color) {
  const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r * 2.1)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  return g
}

export default function VoiceOrb({ state = 'idle', analyser = null }) {
  const canvasRef   = useRef(null)
  const rafRef      = useRef(null)
  const tick        = useRef(0)
  // Keep props accessible inside the rAF loop without stale closures
  const stateRef    = useRef(state)
  const analyserRef = useRef(analyser)

  useEffect(() => { stateRef.current    = state    }, [state])
  useEffect(() => { analyserRef.current = analyser }, [analyser])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const cx = W / 2, cy = H / 2
    const R = 68  // base orb radius in px

    // ── Helpers ──────────────────────────────────────────────────────────────

    const getTimeData = () => {
      const a = analyserRef.current
      if (!a) return null
      const buf = new Uint8Array(a.frequencyBinCount)
      a.getByteTimeDomainData(buf)
      return buf
    }
    const getFreqData = () => {
      const a = analyserRef.current
      if (!a) return null
      const buf = new Uint8Array(a.frequencyBinCount)
      a.getByteFrequencyData(buf)
      return buf
    }
    const amplitude = () => {
      const d = getTimeData()
      if (!d) return 0
      return d.reduce((s, v) => s + Math.abs(v - 128), 0) / d.length
    }

    const drawGlow = (r, c) => {
      ctx.beginPath()
      ctx.arc(cx, cy, r * 2.1, 0, Math.PI * 2)
      ctx.fillStyle = makeGlow(ctx, cx, cy, r, c.glow)
      ctx.fill()
    }
    const drawOrb = (r, c) => {
      // Main orb sphere
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = makeRadial(ctx, cx, cy, r, c.core, c.edge)
      ctx.fill()
      // Subtle inner highlight
      ctx.save()
      ctx.globalAlpha = 0.22
      ctx.beginPath()
      ctx.arc(cx - r * 0.27, cy - r * 0.32, r * 0.28, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fill()
      ctx.restore()
    }

    // ── Animation loop ────────────────────────────────────────────────────────

    const frame = () => {
      rafRef.current = requestAnimationFrame(frame)
      tick.current++
      const t = tick.current
      ctx.clearRect(0, 0, W, H)
      const s = stateRef.current
      const c = PALETTE[s] || PALETTE.idle

      // ── IDLE: gentle sine pulse ──────────────────────────────────────────
      if (s === 'idle') {
        const r = R * (1 + Math.sin(t * 0.022) * 0.09)
        drawGlow(r, c)
        drawOrb(r, c)
      }

      // ── LISTENING: frequency bars + pulse rings ──────────────────────────
      else if (s === 'listening') {
        const amp   = amplitude()
        const scale = 1 + Math.min(amp / 35, 0.38)
        const r     = R * (1 + Math.sin(t * 0.04) * 0.025) * scale

        // Outer pulse rings
        for (let i = 1; i <= 2; i++) {
          ctx.save()
          ctx.globalAlpha = (0.1 + Math.sin(t * 0.06) * 0.04) / i
          ctx.beginPath()
          ctx.arc(cx, cy, r + i * 16, 0, Math.PI * 2)
          ctx.strokeStyle = c.core
          ctx.lineWidth = 1.2
          ctx.stroke()
          ctx.restore()
        }

        // Frequency bars around the orb ring
        const freq = getFreqData()
        if (freq) {
          const bars = 48
          for (let i = 0; i < bars; i++) {
            const angle = (i / bars) * Math.PI * 2 - Math.PI / 2
            const v     = freq[Math.floor(i * freq.length / bars * 0.6)] / 255
            const h     = v * 32 + 3
            const x1 = cx + Math.cos(angle) * (r + 3)
            const y1 = cy + Math.sin(angle) * (r + 3)
            const x2 = cx + Math.cos(angle) * (r + 3 + h)
            const y2 = cy + Math.sin(angle) * (r + 3 + h)
            ctx.save()
            ctx.globalAlpha = 0.45 + v * 0.55
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
            ctx.strokeStyle = c.core
            ctx.lineWidth   = 2.5
            ctx.lineCap     = 'round'
            ctx.stroke()
            ctx.restore()
          }
        }

        drawGlow(r, c)
        drawOrb(r, c)
      }

      // ── THINKING: counter-rotating arc segments ──────────────────────────
      else if (s === 'thinking') {
        const r = R * (1 + Math.sin(t * 0.032) * 0.055)
        const arcs = [
          { n: 3, dist: 14, speed:  0.03,  arc: 0.55, color: c.core, lw: 2   },
          { n: 4, dist: 26, speed: -0.019, arc: 0.4,  color: c.edge, lw: 1.4 },
        ]
        arcs.forEach(({ n, dist, speed, arc, color, lw }) => {
          for (let i = 0; i < n; i++) {
            const a0 = t * speed + (i / n) * Math.PI * 2
            ctx.save()
            ctx.globalAlpha = 0.28
            ctx.beginPath()
            ctx.arc(cx, cy, r + dist, a0, a0 + Math.PI * 2 * arc)
            ctx.strokeStyle = color
            ctx.lineWidth   = lw
            ctx.stroke()
            ctx.restore()
          }
        })
        drawGlow(r, c)
        drawOrb(r, c)
      }

      // ── SPEAKING: ripple rings + horizontal wave bands ───────────────────
      else if (s === 'speaking') {
        const amp = amplitude()
        const r   = R * (1 + Math.sin(t * 0.045) * 0.07 + Math.min(amp / 80, 0.12))

        // Expanding ripple rings synced to playback amplitude
        for (let i = 0; i < 3; i++) {
          const prog = ((t + i * 20) % 60) / 60
          ctx.save()
          ctx.globalAlpha = (1 - prog) * 0.2
          ctx.beginPath()
          ctx.arc(cx, cy, r + prog * 46, 0, Math.PI * 2)
          ctx.strokeStyle = c.core
          ctx.lineWidth   = 1.2
          ctx.stroke()
          ctx.restore()
        }

        // Horizontal soundwave bands
        for (let w = 0; w < 3; w++) {
          ctx.save()
          ctx.globalAlpha = 0.13 - w * 0.03
          ctx.beginPath()
          for (let x = 0; x <= W; x += 2) {
            const y = cy
              + Math.sin((x / W) * Math.PI * 7 + t * 0.07 + w * 1.3) * (10 + amp * 0.6)
              + (w - 1) * 22
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
          }
          ctx.strokeStyle = c.core
          ctx.lineWidth   = 1.5
          ctx.stroke()
          ctx.restore()
        }

        drawGlow(r, c)
        drawOrb(r, c)
      }
    }

    frame()
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])  // register loop once; state/analyser read via refs each frame

  return (
    <canvas
      ref={canvasRef}
      width={220}
      height={220}
      style={{ display: 'block' }}
    />
  )
}
