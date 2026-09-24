import type {
  AnalysisResult,
  AudioFileDescriptor,
  EnergyBand,
  MomentumSegment,
  WaveformPoint
} from '../../../shared/types'

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

const clamp = (value: number, min = 0, max = 1): number => Math.min(Math.max(value, min), max)
const secondsPerMeasure = (beatInterval: number): number => beatInterval * 4

const energyBandFor = (energy: number): EnergyBand => {
  if (energy >= 0.76) return 'peak'
  if (energy >= 0.52) return 'high'
  if (energy >= 0.28) return 'medium'
  return 'low'
}

const labelForBand = (band: EnergyBand): string => {
  switch (band) {
    case 'peak':
      return 'Peak action'
    case 'high':
      return 'Drive'
    case 'medium':
      return 'Pulse'
    case 'low':
      return 'Tension bed'
  }
}

const confidenceFor = (energy: number, momentum: number, duration: number): number => {
  const durationScore = clamp(duration / 16, 0.25, 1)
  const clarityScore = clamp(Math.abs(energy - 0.5) * 1.4 + momentum * 0.35, 0.2, 1)
  return clamp(0.42 + durationScore * 0.28 + clarityScore * 0.3)
}

type BeatEstimate = {
  bpm: number
  beatInterval: number
  confidence: number
}

type LoopCandidate = {
  start: number
  end: number
  confidence: number
  source: 'matched-frames' | 'beat-grid'
}

type FeatureFrame = {
  time: number
  energy: number
  delta: number
}

const smooth = (points: WaveformPoint[]): WaveformPoint[] => {
  return points.map((point, index) => {
    const previous = points[Math.max(index - 1, 0)]
    const next = points[Math.min(index + 1, points.length - 1)]
    return {
      time: point.time,
      energy: (previous.energy + point.energy * 2 + next.energy) / 4,
      momentum: point.momentum
    }
  })
}

const createSegments = (waveform: WaveformPoint[], duration: number): MomentumSegment[] => {
  if (waveform.length === 0) return []

  const minSegmentDuration = Math.min(Math.max(duration / 18, 6), 18)
  const rawSegments: MomentumSegment[] = []
  let startIndex = 0
  let currentBand = energyBandFor(waveform[0].energy)

  for (let index = 1; index < waveform.length; index += 1) {
    const band = energyBandFor(waveform[index].energy)
    const startTime = waveform[startIndex].time
    const segmentDuration = waveform[index].time - startTime

    if (band !== currentBand && segmentDuration >= minSegmentDuration) {
      rawSegments.push(buildSegment(waveform, startIndex, index, currentBand, duration))
      startIndex = index
      currentBand = band
    }
  }

  rawSegments.push(buildSegment(waveform, startIndex, waveform.length - 1, currentBand, duration))

  return rawSegments.reduce<MomentumSegment[]>((segments, segment) => {
    const previous = segments.at(-1)
    if (!previous) return [segment]

    if (segment.duration < minSegmentDuration * 0.7 || previous.band === segment.band) {
      const mergedPoints = waveform.filter((point) => point.time >= previous.in && point.time <= segment.out)
      segments[segments.length - 1] = buildSegmentFromPoints(
        mergedPoints,
        previous.in,
        segment.out,
        energyBandFor((previous.energy + segment.energy) / 2),
        segments.length
      )
      return segments
    }

    return [...segments, { ...segment, id: `seg-${segments.length + 1}` }]
  }, [])
}

const buildSegment = (
  waveform: WaveformPoint[],
  startIndex: number,
  endIndex: number,
  band: EnergyBand,
  duration: number
): MomentumSegment => {
  const points = waveform.slice(startIndex, Math.max(endIndex + 1, startIndex + 1))
  const start = waveform[startIndex].time
  const end = endIndex >= waveform.length - 1 ? duration : waveform[endIndex].time
  return buildSegmentFromPoints(points, start, end, band, startIndex)
}

const buildSegmentFromPoints = (
  points: WaveformPoint[],
  start: number,
  end: number,
  band: EnergyBand,
  indexSeed: number
): MomentumSegment => {
  const energy = points.reduce((total, point) => total + point.energy, 0) / points.length
  const momentum = points.reduce((total, point) => total + point.momentum, 0) / points.length
  const duration = Math.max(end - start, 0)

  return {
    id: `seg-${indexSeed + 1}`,
    label: labelForBand(band),
    band,
    in: start,
    out: end,
    duration,
    energy: clamp(energy),
    momentum: clamp(momentum),
    confidence: confidenceFor(energy, momentum, duration),
    loopSource: 'energy-band'
  }
}

const getMonoSample = (buffer: AudioBuffer, sampleIndex: number): number => {
  let mixed = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    mixed += buffer.getChannelData(channel)[sampleIndex] ?? 0
  }
  return mixed / buffer.numberOfChannels
}

const createFeatureFrames = (buffer: AudioBuffer): FeatureFrame[] => {
  const hopSeconds = 0.08
  const hopSize = Math.max(256, Math.floor(buffer.sampleRate * hopSeconds))
  const frames: FeatureFrame[] = []
  let peak = 0

  for (let start = 0; start < buffer.length; start += hopSize) {
    const end = Math.min(start + hopSize, buffer.length)
    let sumSquares = 0
    let count = 0

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const sample = getMonoSample(buffer, sampleIndex)
      sumSquares += sample * sample
      count += 1
    }

    const energy = Math.sqrt(sumSquares / Math.max(count, 1))
    peak = Math.max(peak, energy)
    frames.push({
      time: start / buffer.sampleRate,
      energy,
      delta: 0
    })
  }

  const normalized = frames.map((frame, index) => {
    const previous = frames[Math.max(index - 1, 0)]
    const energy = clamp(frame.energy / Math.max(peak, 0.0001))
    const previousEnergy = clamp(previous.energy / Math.max(peak, 0.0001))
    return {
      ...frame,
      energy,
      delta: Math.max(0, energy - previousEnergy)
    }
  })

  return normalized
}

const estimateBeat = (frames: FeatureFrame[]): BeatEstimate | null => {
  if (frames.length < 40) return null

  const hopSeconds = Math.max(frames[1].time - frames[0].time, 0.08)
  const onset = frames.map((frame) => frame.delta)
  const minLag = Math.max(1, Math.round((60 / 190) / hopSeconds))
  const maxLag = Math.min(onset.length - 2, Math.round((60 / 70) / hopSeconds))
  let bestLag = 0
  let bestScore = 0
  let totalScore = 0

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0
    for (let index = lag; index < onset.length; index += 1) {
      score += onset[index] * onset[index - lag]
    }
    score /= onset.length - lag
    totalScore += score
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }

  if (bestLag === 0 || bestScore <= 0) return null

  const beatInterval = bestLag * hopSeconds
  const confidence = clamp(bestScore / Math.max(totalScore / Math.max(maxLag - minLag + 1, 1), 0.0001) / 4)

  return {
    bpm: 60 / beatInterval,
    beatInterval,
    confidence
  }
}

const scoreLoopSeam = (
  frames: FeatureFrame[],
  start: number,
  end: number,
  compareDuration: number
): number => {
  const frameStep = frames[1] ? frames[1].time - frames[0].time : 0.08
  const step = Math.max(frameStep, 0.08)
  const count = Math.max(8, Math.floor(compareDuration / step))
  let diff = 0
  let deltaDiff = 0
  let compared = 0

  for (let offset = 0; offset < count; offset += 1) {
    const beforeTime = start + offset * step
    const afterTime = end + offset * step
    const beforeFrame = frames.find((frame) => frame.time >= beforeTime)
    const afterFrame = frames.find((frame) => frame.time >= afterTime)
    if (!beforeFrame || !afterFrame) break

    diff += Math.abs(beforeFrame.energy - afterFrame.energy)
    deltaDiff += Math.abs(beforeFrame.delta - afterFrame.delta)
    compared += 1
  }

  if (compared < 6) return 0
  const averageDiff = diff / compared
  const averageDeltaDiff = deltaDiff / compared
  return clamp(1 - (averageDiff * 1.25 + averageDeltaDiff * 1.8))
}

const createBeatGridCandidates = (
  duration: number,
  beatEstimate: BeatEstimate | null
): LoopCandidate[] => {
  if (!beatEstimate) return []

  const measure = secondsPerMeasure(beatEstimate.beatInterval)
  const eightBar = measure * 8
  if (!Number.isFinite(eightBar) || eightBar < 6) return []

  const candidates: LoopCandidate[] = []
  for (let start = 0; start + eightBar <= duration + 0.25; start += eightBar) {
    const end = Math.min(start + eightBar, duration)
    if (end - start >= Math.max(6, eightBar * 0.65)) {
      candidates.push({
        start,
        end,
        confidence: clamp(0.48 + beatEstimate.confidence * 0.24),
        source: 'beat-grid'
      })
    }
  }

  return candidates
}

const findNaturalLoopCandidates = (
  frames: FeatureFrame[],
  duration: number,
  beatEstimate: BeatEstimate | null
): LoopCandidate[] => {
  if (duration < 8 || frames.length < 80) return []

  const beatInterval = beatEstimate?.beatInterval ?? 0.5
  const measure = secondsPerMeasure(beatInterval)
  const grid = Math.max(beatInterval, 0.35)
  const compareDuration = Math.min(Math.max(beatInterval * 4, 1.6), 4)
  const candidateLengths = beatEstimate
    ? [measure * 8, measure * 16, measure * 4].filter((length) => length >= 6 && length <= duration * 0.75)
    : [8, 12, 16, 24, 32].filter((length) => length <= duration * 0.75)
  const candidates: LoopCandidate[] = []

  for (let start = 0; start < duration - 6; start += grid) {
    for (const length of candidateLengths) {
      const centerEnd = start + length
      if (centerEnd + compareDuration > duration) continue

      let bestEnd = centerEnd
      let bestScore = 0
      for (let offset = -beatInterval; offset <= beatInterval; offset += Math.max(beatInterval / 4, 0.12)) {
        const end = centerEnd + offset
        if (end - start < 6 || end + compareDuration > duration) continue
        const score = scoreLoopSeam(frames, start, end, compareDuration)
        if (score > bestScore) {
          bestScore = score
          bestEnd = end
        }
      }

      if (bestScore >= 0.72) {
        candidates.push({
          start,
          end: bestEnd,
          confidence: clamp(bestScore * 0.78 + (beatEstimate?.confidence ?? 0.3) * 0.22),
          source: 'matched-frames'
        })
      }
    }
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .reduce<LoopCandidate[]>((accepted, candidate) => {
      const overlaps = accepted.some(
        (existing) => candidate.start < existing.end - 0.5 && candidate.end > existing.start + 0.5
      )
      if (!overlaps) accepted.push(candidate)
      return accepted
    }, [])
    .sort((a, b) => a.start - b.start)
}

const createLoopSegments = (
  waveform: WaveformPoint[],
  duration: number,
  beatEstimate: BeatEstimate | null
): MomentumSegment[] => {
  const features = waveform.map((point, index) => {
    const previous = waveform[Math.max(index - 1, 0)]
    return {
      time: point.time,
      energy: point.energy,
      delta: Math.max(0, point.energy - previous.energy)
    }
  })
  const naturalCandidates = findNaturalLoopCandidates(features, duration, beatEstimate)
  const candidates = naturalCandidates.length > 0 ? naturalCandidates : createBeatGridCandidates(duration, beatEstimate)

  return candidates.map((candidate, index) => {
    const points = waveform.filter((point) => point.time >= candidate.start && point.time <= candidate.end)
    const band = energyBandFor(points.reduce((total, point) => total + point.energy, 0) / Math.max(points.length, 1))
    return {
      ...buildSegmentFromPoints(points.length > 0 ? points : waveform, candidate.start, candidate.end, band, index),
      id: `${candidate.source === 'matched-frames' ? 'loop' : 'beat'}-${index + 1}`,
      label: candidate.source === 'matched-frames' ? `Loop ${index + 1}` : `8-bar loop ${index + 1}`,
      confidence: clamp(candidate.confidence),
      loopSource: candidate.source
    }
  })
}

export const analyzeAudioFile = async (
  track: AudioFileDescriptor,
  onProgress: (progress: number) => void
): Promise<AnalysisResult> => {
  onProgress(0.04)
  const audioData = await window.pindex.readAudioFile(track.path)
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextConstructor) {
    throw new Error('This environment does not support Web Audio analysis.')
  }
  const audioContext = new AudioContextConstructor()

  try {
    onProgress(0.24)
    const buffer = await audioContext.decodeAudioData(audioData.slice(0))
    const channelCount = buffer.numberOfChannels
    const samples = buffer.length
    const featureFrames = createFeatureFrames(buffer)
    const beatEstimate = estimateBeat(featureFrames)
    const pointCount = Math.min(520, Math.max(80, Math.floor(buffer.duration * 3)))
    const frameSize = Math.max(1, Math.floor(samples / pointCount))
    const waveform: WaveformPoint[] = []
    let peakEnergy = 0

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const start = pointIndex * frameSize
      const end = Math.min(start + frameSize, samples)
      let sumSquares = 0
      let sampleCount = 0

      for (let channel = 0; channel < channelCount; channel += 1) {
        const channelData = buffer.getChannelData(channel)
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
          const sample = channelData[sampleIndex]
          sumSquares += sample * sample
          sampleCount += 1
        }
      }

      const rms = Math.sqrt(sumSquares / Math.max(sampleCount, 1))
      peakEnergy = Math.max(peakEnergy, rms)
      waveform.push({
        time: start / buffer.sampleRate,
        energy: rms,
        momentum: 0
      })

      if (pointIndex % 24 === 0) {
        onProgress(0.24 + (pointIndex / pointCount) * 0.5)
      }
    }

    const normalized = smooth(
      waveform.map((point) => ({
        ...point,
        energy: clamp(point.energy / Math.max(peakEnergy, 0.0001))
      }))
    )

    const momentumWaveform = normalized.map((point, index) => {
      const previous = normalized[Math.max(index - 1, 0)]
      const next = normalized[Math.min(index + 1, normalized.length - 1)]
      const slope = Math.abs(next.energy - previous.energy)
      return {
        ...point,
        momentum: clamp(slope * 3.8 + point.energy * 0.24)
      }
    })

    onProgress(0.84)
    const averageEnergy =
      momentumWaveform.reduce((total, point) => total + point.energy, 0) / momentumWaveform.length
    const averageMomentum =
      momentumWaveform.reduce((total, point) => total + point.momentum, 0) / momentumWaveform.length
    const loopSegments = createLoopSegments(momentumWaveform, buffer.duration, beatEstimate)
    const segments = loopSegments.length > 0 ? loopSegments : createSegments(momentumWaveform, buffer.duration)

    onProgress(1)
    return {
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: channelCount,
      averageEnergy,
      peakEnergy: 1,
      averageMomentum,
      estimatedBpm: beatEstimate ? Math.round(beatEstimate.bpm * 10) / 10 : undefined,
      beatInterval: beatEstimate?.beatInterval,
      waveform: momentumWaveform,
      segments
    }
  } finally {
    void audioContext.close()
  }
}
