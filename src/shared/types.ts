export type AudioFileDescriptor = {
  id: string
  path: string
  fileUrl: string
  name: string
  extension: string
  size: number
  lastModified: number
}

export type AnalysisStatus = 'idle' | 'queued' | 'analyzing' | 'complete' | 'error'

export type EnergyBand = 'low' | 'medium' | 'high' | 'peak'

export type MomentumSegment = {
  id: string
  label: string
  band: EnergyBand
  in: number
  out: number
  duration: number
  energy: number
  momentum: number
  confidence: number
  loopSource?: 'matched-frames' | 'beat-grid' | 'energy-band' | 'manual'
}

export type WaveformPoint = {
  time: number
  energy: number
  momentum: number
}

export type AnalysisResult = {
  duration: number
  sampleRate: number
  channels: number
  averageEnergy: number
  peakEnergy: number
  averageMomentum: number
  estimatedBpm?: number
  beatInterval?: number
  waveform: WaveformPoint[]
  segments: MomentumSegment[]
}

export type TrackAnalysisState = {
  status: AnalysisStatus
  progress: number
  error?: string
  result?: AnalysisResult
}

export type IndexFile = {
  version: 1
  generatedAt: string
  source: {
    name: string
    path: string
    duration: number
    sampleRate: number
    channels: number
  }
  summary: {
    averageEnergy: number
    peakEnergy: number
    averageMomentum: number
    estimatedBpm?: number
    segmentCount: number
  }
  segments: MomentumSegment[]
}

export type SaveIndexPayload = {
  defaultPath: string
  contents: IndexFile
}

export type SaveIndexResult = {
  canceled: boolean
  filePath?: string
}
