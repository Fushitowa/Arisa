import { useEffect, useState } from 'react'

const EXPRESSIONS = {
  calm: '/characters/arisa/calm.png',
  curious: '/characters/arisa/curious.png',
  blush: '/characters/arisa/blush.png',
  concerned: '/characters/arisa/concerned.png',
  happy: '/characters/arisa/happy.png',
  surprised: '/characters/arisa/surprised.png',
  shy: '/characters/arisa/shy.png',
  encouraging: '/characters/arisa/encouraging.png',
  sleepy: '/characters/arisa/sleepy.png',
  nervous: '/characters/arisa/nervous.png',
  determined: '/characters/arisa/determined.png',
  celebrating: '/characters/arisa/celebrating.png',
}

export function inferArisaEmotion(text = '') {
  const tone = text.match(/^\s*\[Tone:\s*([^\]]+)\]/i)?.[1]?.trim().toLowerCase()
  if (tone === 'loving & affectionate') return 'happy'
  if (tone === 'gentle encouragement') return 'encouraging'
  if (tone === 'playful') return 'happy'
  if (tone === 'concerned & caring') return 'concerned'
  if (tone === 'excited') return 'celebrating'
  if (tone === 'calm & thoughtful') return 'calm'

  const value = text.toLowerCase()
  if (/\b(congratulations|you did it|nailed it|celebrate|that's a win|amazing job)\b/.test(value)) return 'celebrating'
  if (/\b(sorry|apolog|i'm sorry|that sounds hard|that sounds difficult|i understand|i'm here for you|worried|sad|stressful)\b/.test(value)) return 'concerned'
  if (/\b(wow|whoa|no way|incredible|unexpected|really\?)\b/.test(value)) return 'surprised'
  if (/\b(embarrass|awkward|blush|shy)\b/.test(value)) return 'shy'
  if (/\b(let's do this|we can tackle|you've got this|you can do it|keep going|i believe in you|proud of you)\b/.test(value)) return 'encouraging'
  if (/\b(tired|sleep|bedtime|rest well)\b/.test(value)) return 'sleepy'
  if (/\b(angry|frustrat|annoying|unfair|upset)\b/.test(value)) return 'blush'
  if (/[?？]/.test(text)) return 'curious'
  if (/\b(glad|happy|great|wonderful|lovely|nice|excellent|delighted|good news)\b/.test(value)) return 'happy'
  if (/\b(start with|take it one step|let's begin|we'll figure it out)\b/.test(value)) return 'determined'
  return 'calm'
}

export default function ArisaCharacter({ state = 'idle', emotion = 'calm', analyser = null }) {
  const [audioLevel, setAudioLevel] = useState(0)

  useEffect(() => {
    if (!analyser || !['listening', 'speaking'].includes(state)) {
      setAudioLevel(0)
      return
    }
    let frame
    let lastUpdate = 0
    const data = new Uint8Array(analyser.frequencyBinCount)
    const update = now => {
      frame = requestAnimationFrame(update)
      if (now - lastUpdate < 75) return
      lastUpdate = now
      analyser.getByteFrequencyData(data)
      const limit = Math.min(data.length, 48)
      let sum = 0
      for (let i = 0; i < limit; i++) sum += data[i]
      setAudioLevel(Math.min(1, sum / limit / 100))
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [analyser, state])

  const expression = state === 'thinking'
    ? 'curious'
    : state === 'listening'
      ? 'calm'
      : state === 'speaking'
        ? (EXPRESSIONS[emotion] ? emotion : 'calm')
        : 'calm'

  return (
    <div
      className={`arisa-character character-${state} expression-${expression}`}
      style={{
        '--audio-level': audioLevel,
        '--audio-scale': 1 + audioLevel * 0.14,
      }}
      role="img"
      aria-label={`Arisa ${state === 'speaking' ? `is speaking with a ${expression} expression` : state}`}
    >
      <span className="character-aura" aria-hidden="true" />
      <span className="character-sound-rings" aria-hidden="true"><i /><i /><i /></span>
      <img src={EXPRESSIONS[expression]} alt="" draggable="false" />
      {state === 'speaking' && <span className="character-voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
    </div>
  )
}
