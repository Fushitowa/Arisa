import { useEffect, useState } from 'react'

const EXPRESSION_NAMES = [
  'neutral', 'happy', 'smiling', 'concerned', 'shy', 'angry', 'surprised', 'laughing',
  'embarrassed', 'crying', 'tired', 'cute', 'scared', 'thinking', 'serious', 'sleepy',
  'blushing', 'excited', 'focused', 'pouty',
]

const EXPRESSIONS = Object.fromEntries(EXPRESSION_NAMES.map((name, index) => {
  const number = String(index + 1).padStart(2, '0')
  return [name, `/characters/arisa/reactions/${number}-${name}.png`]
}))

export function inferArisaEmotion(text = '') {
  const tone = text.match(/^\s*\[Tone:\s*([^\]]+)\]/i)?.[1]?.trim().toLowerCase()
  const toneExpressions = {
    'loving & affectionate': 'smiling',
    'gentle encouragement': 'happy',
    playful: 'cute',
    'concerned & caring': 'concerned',
    excited: 'excited',
    'calm & thoughtful': 'thinking',
  }
  if (toneExpressions[tone]) return toneExpressions[tone]

  const value = text.toLowerCase()
  if (/\b(congratulations|you did it|nailed it|celebrate|that's a win|amazing job)\b/.test(value)) return 'excited'
  if (/\b(crying|tears|heartbroken|grief|devastated)\b/.test(value)) return 'crying'
  if (/\b(sorry|apolog|that sounds hard|that sounds difficult|i understand|i'm here for you|worried|stressful|sad|unhappy)\b/.test(value)) return 'concerned'
  if (/\b(disgust|gross|repulsed|angry|furious|unfair|rage|frustrat|overwhelmed|fed up|mad at|mad about|i'm mad)\b/.test(value)) return 'angry'
  if (/\b(blushing|rosy cheeks)\b/.test(value)) return 'blushing'
  if (/\b(embarrass|awkward)\b/.test(value)) return 'embarrassed'
  if (/\b(blush)\b/.test(value)) return 'blushing'
  if (/\b(shy|bashful)\b/.test(value)) return 'shy'
  if (/\b(flirt|gorgeous|beautiful|handsome|love you|cute|adorable|tease|kidding|just playing)\b/.test(value)) return 'cute'
  if (/\b(wow|whoa|no way|incredible|unexpected|shocked|can't believe|unbelievable|stunned|speechless)\b/.test(value)) return 'surprised'
  if (/\b(scared|terrified|frightened|danger|nervous|anxious|uneasy|afraid)\b/.test(value)) return 'scared'
  if (/\b(sleepy|bedtime|rest well|good night)\b/.test(value)) return 'sleepy'
  if (/\b(tired|exhausted|worn out|bored|boring)\b/.test(value)) return 'tired'
  if (/\b(hesitat|not sure|perhaps|maybe|doubt|unlikely|uncertain|confus|unclear|what do you mean)\b/.test(value) || /[?？]/.test(text)) return 'thinking'
  if (/\b(let's do this|we can tackle|you've got this|you can do it|keep going|i believe in you|proud of you|happy to help|welcome|nice to meet)\b/.test(value)) return 'happy'
  if (/\b(start with|take it one step|let's begin|we'll figure it out|focus|step by step|carefully)\b/.test(value)) return 'focused'
  if (/\b(glad|happy|great|wonderful|lovely|nice|excellent|delighted|good news)\b/.test(value)) return 'happy'
  if (/\b(laugh|haha|lol)\b/.test(value)) return 'laughing'
  if (/\b(smile|smiling)\b/.test(value)) return 'smiling'
  if (/\b(pout|pouting)\b/.test(value)) return 'pouty'
  if (/\b(serious|important|carefully)\b/.test(value)) return 'serious'
  return 'neutral'
}

export default function ArisaCharacter({ state = 'idle', emotion = 'neutral', analyser = null }) {
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
    ? 'thinking'
    : state === 'speaking'
      ? (EXPRESSIONS[emotion] ? emotion : 'neutral')
      : 'neutral'

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
