import { useEffect, useState } from 'react'

const EXPRESSION_NAMES = [
  'neutral', 'happy', 'smiling', 'laughing', 'blushing', 'shy', 'cute', 'wink',
  'annoyed', 'angry', 'mad', 'frustrated', 'sad', 'crying', 'depressed', 'lonely',
  'surprised', 'shocked', 'scared', 'confused', 'thinking', 'curious', 'doubtful', 'serious',
  'sleepy', 'tired', 'bored', 'embarrassed', 'nervous', 'worried', 'hopeful', 'excited',
  'teasing', 'flirty', 'friendly', 'focused', 'disgusted', 'pouty', 'hesitant', 'stunned',
]

const EXPRESSIONS = Object.fromEntries(EXPRESSION_NAMES.map((name, index) => {
  const number = String(index + 1).padStart(2, '0')
  return [name, `/characters/arisa/expressions/${number}-${name}.png`]
}))

export function inferArisaEmotion(text = '') {
  const tone = text.match(/^\s*\[Tone:\s*([^\]]+)\]/i)?.[1]?.trim().toLowerCase()
  const toneExpressions = {
    'loving & affectionate': 'friendly',
    'gentle encouragement': 'hopeful',
    playful: 'teasing',
    'concerned & caring': 'worried',
    excited: 'excited',
    'calm & thoughtful': 'thinking',
  }
  if (toneExpressions[tone]) return toneExpressions[tone]

  const value = text.toLowerCase()
  if (/\b(congratulations|you did it|nailed it|celebrate|that's a win|amazing job)\b/.test(value)) return 'excited'
  if (/\b(crying|tears|heartbroken|grief|devastated)\b/.test(value)) return 'crying'
  if (/\b(depressed|hopeless|despair)\b/.test(value)) return 'depressed'
  if (/\b(lonely|alone|isolated)\b/.test(value)) return 'lonely'
  if (/\b(sad|unhappy|downhearted)\b/.test(value)) return 'sad'
  if (/\b(sorry|apolog|that sounds hard|that sounds difficult|i understand|i'm here for you|worried|stressful|afraid)\b/.test(value)) return 'worried'
  if (/\b(disgust|gross|repulsed)\b/.test(value)) return 'disgusted'
  if (/\b(frustrat|overwhelmed|fed up)\b/.test(value)) return 'frustrated'
  if (/\b(mad at|mad about|i'm mad|so mad)\b/.test(value)) return 'mad'
  if (/\b(angry|furious|unfair|rage)\b/.test(value)) return 'angry'
  if (/\b(annoy|irritat)\b/.test(value)) return 'annoyed'
  if (/\b(blushing|rosy cheeks)\b/.test(value)) return 'blushing'
  if (/\b(embarrass|awkward|blush)\b/.test(value)) return 'embarrassed'
  if (/\b(shy|bashful)\b/.test(value)) return 'shy'
  if (/\b(flirt|gorgeous|beautiful|handsome|love you)\b/.test(value)) return 'flirty'
  if (/\b(tease|kidding|just playing)\b/.test(value)) return 'teasing'
  if (/\b(wow|whoa|no way|incredible|unexpected)\b/.test(value)) return 'surprised'
  if (/\b(shocked|can't believe|unbelievable)\b/.test(value)) return 'shocked'
  if (/\b(scared|terrified|frightened|danger)\b/.test(value)) return 'scared'
  if (/\b(nervous|anxious|uneasy)\b/.test(value)) return 'nervous'
  if (/\b(sleepy|bedtime|rest well|good night)\b/.test(value)) return 'sleepy'
  if (/\b(tired|exhausted|worn out)\b/.test(value)) return 'tired'
  if (/\b(bored|boring)\b/.test(value)) return 'bored'
  if (/\b(hesitat|not sure|perhaps|maybe)\b/.test(value)) return 'hesitant'
  if (/\b(doubt|unlikely|uncertain)\b/.test(value)) return 'doubtful'
  if (/\b(confus|unclear|what do you mean)\b/.test(value)) return 'confused'
  if (/\b(curiously|interesting question|i wonder)\b/.test(value) || /[?？]/.test(text)) return 'curious'
  if (/\b(let's do this|we can tackle|you've got this|you can do it|keep going|i believe in you|proud of you)\b/.test(value)) return 'hopeful'
  if (/\b(start with|take it one step|let's begin|we'll figure it out|focus|step by step)\b/.test(value)) return 'focused'
  if (/\b(glad|happy|great|wonderful|lovely|nice|excellent|delighted|good news)\b/.test(value)) return 'happy'
  if (/\b(friendly|welcome|nice to meet|happy to help)\b/.test(value)) return 'friendly'
  if (/\b(cute|adorable)\b/.test(value)) return 'cute'
  if (/\b(wink|gotcha)\b/.test(value)) return 'wink'
  if (/\b(laugh|haha|lol)\b/.test(value)) return 'laughing'
  if (/\b(smile|smiling)\b/.test(value)) return 'smiling'
  if (/\b(pout|pouting)\b/.test(value)) return 'pouty'
  if (/\b(stunned|speechless)\b/.test(value)) return 'stunned'
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
