import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, RefObject } from 'react'
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Disc3,
  Download,
  FileAudio,
  FolderOpen,
  Loader2,
  Minus,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Volume2,
  VolumeX,
  XCircle
} from 'lucide-react'
import type {
  AnalysisResult,
  AudioFileDescriptor,
  EnergyBand,
  IndexFile,
  MomentumSegment,
  TrackAnalysisState,
  WaveformPoint
} from '../../shared/types'
import { analyzeAudioFile } from './analysis/audioAnalysis'
import { formatBytes, formatPercent, formatTime, makeIndexFilename } from './utils/format'

type Track = AudioFileDescriptor & {
  analysis: TrackAnalysisState
}

type VisibleRange = {
  start: number
  end: number
}

type PlaybackSource = {
  trackId: string
  url: string
}

type TrimDragSession = {
  edge: 'in' | 'out'
  range: VisibleRange
  originalIn: number
  originalOut: number
}

const emptyAnalysis: TrackAnalysisState = { status: 'idle', progress: 0 }

const AUDIO_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm'
}

const toTrack = (file: AudioFileDescriptor): Track => ({
  ...file,
  analysis: { ...emptyAnalysis }
})

const clamp = (value: number, min = 0, max = 1): number => Math.min(Math.max(value, min), max)

const bandForEnergy = (energy: number): EnergyBand => {
  if (energy >= 0.76) return 'peak'
  if (energy >= 0.52) return 'high'
  if (energy >= 0.28) return 'medium'
  return 'low'
}

const buildIndexFile = (track: Track, result: AnalysisResult): IndexFile => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  source: {
    name: track.name,
    path: track.path,
    duration: result.duration,
    sampleRate: result.sampleRate,
    channels: result.channels
  },
  summary: {
    averageEnergy: result.averageEnergy,
    peakEnergy: result.peakEnergy,
    averageMomentum: result.averageMomentum,
    estimatedBpm: result.estimatedBpm,
    segmentCount: result.segments.length
  },
  segments: result.segments
})

const statusIcon = (analysis: TrackAnalysisState): ReactElement => {
  switch (analysis.status) {
    case 'analyzing':
      return <Loader2 className="status-icon spinning" />
    case 'complete':
      return <CheckCircle2 className="status-icon complete" />
    case 'error':
      return <XCircle className="status-icon error" />
    case 'queued':
      return <Activity className="status-icon queued" />
    default:
      return <Minus className="status-icon muted" />
  }
}

const summarizePoints = (points: WaveformPoint[]): Pick<MomentumSegment, 'energy' | 'momentum' | 'band' | 'confidence'> => {
  if (points.length === 0) {
    return {
      energy: 0.4,
      momentum: 0.25,
      band: 'medium',
      confidence: 0.6
    }
  }

  const energy = points.reduce((total, point) => total + point.energy, 0) / points.length
  const momentum = points.reduce((total, point) => total + point.momentum, 0) / points.length

  return {
    energy,
    momentum,
    band: bandForEnergy(energy),
    confidence: clamp(0.52 + Math.abs(energy - 0.5) * 0.36 + momentum * 0.22)
  }
}

const waitForAudioReady = async (audio: HTMLAudioElement): Promise<void> => {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      audio.removeEventListener('canplay', handleReady)
      audio.removeEventListener('loadeddata', handleReady)
      audio.removeEventListener('error', handleError)
    }
    const handleReady = (): void => {
      cleanup()
      resolve()
    }
    const handleError = (): void => {
      cleanup()
      reject(new Error(audio.error?.message || 'The audio file could not be loaded for playback.'))
    }

    audio.addEventListener('canplay', handleReady, { once: true })
    audio.addEventListener('loadeddata', handleReady, { once: true })
    audio.addEventListener('error', handleError, { once: true })
  })
}

export function App(): ReactElement {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(0.82)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playbackUrlRef = useRef<string | null>(null)

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedId) ?? tracks[0] ?? null,
    [selectedId, tracks]
  )

  const result = selectedTrack?.analysis.result
  const selectedSegment = useMemo(
    () => result?.segments.find((segment) => segment.id === selectedSegmentId) ?? null,
    [result?.segments, selectedSegmentId]
  )
  const visibleRange: VisibleRange | null = useMemo(() => {
    if (!result) return null
    if (selectedSegment) return { start: selectedSegment.in, end: selectedSegment.out }
    return { start: 0, end: result.duration }
  }, [result, selectedSegment])

  const completedCount = tracks.filter((track) => track.analysis.status === 'complete').length
  const queuedCount = tracks.filter((track) => track.analysis.status === 'queued').length
  const analyzingCount = tracks.filter((track) => track.analysis.status === 'analyzing').length

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = isMuted
  }, [isMuted, selectedTrack?.id, volume])

  useEffect(() => {
    setSelectedSegmentId(null)
    setCurrentTime(0)
    setIsPlaying(false)

    const audio = audioRef.current
    audio?.pause()
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current)
      playbackUrlRef.current = null
    }
    setPlaybackSource(null)
  }, [selectedTrack?.id])

  useEffect(() => {
    return () => {
      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !isPlaying) return

    let frame = 0
    const tick = (): void => {
      let nextTime = audio.currentTime

      if (selectedSegment && nextTime >= selectedSegment.out - 0.02) {
        audio.currentTime = selectedSegment.in
        nextTime = selectedSegment.in
      }

      setCurrentTime(nextTime)
      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [isPlaying, selectedSegment?.id, selectedSegment?.in, selectedSegment?.out])

  const addTracks = (files: AudioFileDescriptor[]): void => {
    if (files.length === 0) return

    setTracks((current) => {
      const knownPaths = new Set(current.map((track) => track.path))
      const incoming = files.filter((file) => !knownPaths.has(file.path)).map(toTrack)
      if (incoming.length === 0) return current
      if (!selectedId) setSelectedId(incoming[0].id)
      return [...current, ...incoming]
    })
  }

  const updateAnalysis = useCallback((trackId: string, analysis: Partial<TrackAnalysisState>): void => {
    setTracks((current) =>
      current.map((track) =>
        track.id === trackId ? { ...track, analysis: { ...track.analysis, ...analysis } } : track
      )
    )
  }, [])

  const analyzeTrack = useCallback(
    async (track: Track): Promise<AnalysisResult | null> => {
      updateAnalysis(track.id, { status: 'analyzing', progress: 0, error: undefined })
      try {
        const analysisResult = await analyzeAudioFile(track, (progress) => {
          updateAnalysis(track.id, { progress })
        })
        updateAnalysis(track.id, { status: 'complete', progress: 1, result: analysisResult })
        return analysisResult
      } catch (error) {
        updateAnalysis(track.id, {
          status: 'error',
          progress: 0,
          error: error instanceof Error ? error.message : 'Analysis failed'
        })
        return null
      }
    },
    [updateAnalysis]
  )

  const seekTo = useCallback((time: number): void => {
    const audio = audioRef.current
    const clampedTime = Math.max(0, time)
    if (audio) audio.currentTime = clampedTime
    setCurrentTime(clampedTime)
  }, [])

  const playAudio = useCallback(async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) return
    await audio.play()
    setIsPlaying(true)
  }, [])

  const ensurePlaybackSource = useCallback(
    async (track: Track): Promise<void> => {
      const audio = audioRef.current
      if (!audio) return

      if (playbackSource?.trackId === track.id && audio.src.startsWith('blob:')) {
        await waitForAudioReady(audio)
        return
      }

      const audioData = await window.pindex.readAudioFile(track.path)
      const blob = new Blob([audioData], {
        type: AUDIO_MIME_TYPES[track.extension] ?? 'application/octet-stream'
      })
      const url = URL.createObjectURL(blob)

      if (playbackUrlRef.current) {
        URL.revokeObjectURL(playbackUrlRef.current)
      }

      playbackUrlRef.current = url
      setPlaybackSource({ trackId: track.id, url })
      audio.src = url
      audio.load()
      await waitForAudioReady(audio)
    },
    [playbackSource?.trackId]
  )

  const pauseAudio = useCallback((): void => {
    const audio = audioRef.current
    audio?.pause()
    setIsPlaying(false)
  }, [])

  const handleOpenFiles = async (): Promise<void> => {
    addTracks(await window.pindex.openAudioFiles())
  }

  const handleOpenFolder = async (): Promise<void> => {
    addTracks(await window.pindex.openAudioFolder())
  }

  const handleAnalyzeSelected = async (): Promise<void> => {
    if (!selectedTrack) return
    await analyzeTrack(selectedTrack)
  }

  const handleAnalyzeAll = async (): Promise<void> => {
    const pending = tracks.filter((track) => track.analysis.status !== 'complete')
    setTracks((current) =>
      current.map((track) =>
        pending.some((queuedTrack) => queuedTrack.id === track.id)
          ? { ...track, analysis: { ...track.analysis, status: 'queued', progress: 0 } }
          : track
      )
    )

    for (const track of pending) {
      await analyzeTrack(track)
    }
  }

  const handlePlayPause = async (): Promise<void> => {
    if (!selectedTrack || selectedTrack.analysis.status === 'analyzing') return

    if (isPlaying) {
      pauseAudio()
      return
    }

    const analysisResult = selectedTrack.analysis.result ?? (await analyzeTrack(selectedTrack))
    if (!analysisResult) return

    try {
      await ensurePlaybackSource(selectedTrack)
    } catch (error) {
      updateAnalysis(selectedTrack.id, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not load audio for playback'
      })
      return
    }

    const loopTarget =
      selectedSegment ?? analysisResult.segments.find((segment) => segment.id === selectedSegmentId) ?? null
    if (loopTarget && (currentTime < loopTarget.in || currentTime >= loopTarget.out)) {
      seekTo(loopTarget.in)
    }

    try {
      updateAnalysis(selectedTrack.id, { error: undefined })
      await playAudio()
      updateAnalysis(selectedTrack.id, { status: 'complete', error: undefined })
    } catch (error) {
      updateAnalysis(selectedTrack.id, {
        status: 'error',
        error: error instanceof Error ? error.message : 'Playback failed'
      })
    }
  }

  const handleRestart = async (): Promise<void> => {
    const restartTime = selectedSegment?.in ?? 0
    seekTo(restartTime)
    if (isPlaying) {
      try {
        await playAudio()
      } catch {
        setIsPlaying(false)
      }
    }
  }

  const updateSelectedResult = useCallback(
    (updater: (result: AnalysisResult) => AnalysisResult): void => {
      if (!selectedTrack?.analysis.result) return

      setTracks((current) =>
        current.map((track) => {
          if (track.id !== selectedTrack.id || !track.analysis.result) return track
          return {
            ...track,
            analysis: {
              ...track.analysis,
              result: updater(track.analysis.result)
            }
          }
        })
      )
    },
    [selectedTrack?.analysis.result, selectedTrack?.id]
  )

  const handleSelectSegment = async (segment: MomentumSegment): Promise<void> => {
    if (selectedTrack) {
      try {
        await ensurePlaybackSource(selectedTrack)
        updateAnalysis(selectedTrack.id, { error: undefined })
      } catch (error) {
        updateAnalysis(selectedTrack.id, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not load audio for playback'
        })
        return
      }
    }

    setSelectedSegmentId(segment.id)
    seekTo(segment.in)
    try {
      await playAudio()
    } catch {
      setIsPlaying(false)
    }
  }

  const handleClearSegmentSelection = (): void => {
    setSelectedSegmentId(null)
  }

  const handleCreateSegment = (): void => {
    if (!result) return

    const start = clamp(currentTime, 0, Math.max(result.duration - 0.25, 0))
    const end = clamp(start + Math.min(12, result.duration - start), start + 0.25, result.duration)
    const points = result.waveform.filter((point) => point.time >= start && point.time <= end)
    const summary = summarizePoints(points)
    const segment: MomentumSegment = {
      id: `manual-${Date.now()}`,
      label: 'Manual cue',
      in: start,
      out: end,
      duration: end - start,
      loopSource: 'manual',
      ...summary
    }

    updateSelectedResult((currentResult) => ({
      ...currentResult,
      segments: [...currentResult.segments, segment].sort((a, b) => a.in - b.in)
    }))
    setSelectedSegmentId(segment.id)
    seekTo(start)
  }

  const handleDeleteSelectedSegment = (): void => {
    if (!selectedSegmentId) return

    updateSelectedResult((currentResult) => ({
      ...currentResult,
      segments: currentResult.segments.filter((segment) => segment.id !== selectedSegmentId)
    }))
    setSelectedSegmentId(null)
  }

  const handleUpdateSegmentTimes = (segmentId: string, nextIn: number, nextOut: number): void => {
    if (!result) return

    const previousSegment = result.segments.find((segment) => segment.id === segmentId)
    const start = clamp(nextIn, 0, Math.max(result.duration - 0.1, 0))
    const end = clamp(nextOut, start + 0.1, result.duration)

    updateSelectedResult((currentResult) => ({
      ...currentResult,
      segments: currentResult.segments
        .map((segment) => {
          if (segment.id !== segmentId) return segment
          const points = currentResult.waveform.filter((point) => point.time >= start && point.time <= end)
          return {
            ...segment,
            ...summarizePoints(points),
            in: start,
            out: end,
            duration: end - start
          }
        })
        .sort((a, b) => a.in - b.in)
    }))

    if (selectedSegmentId === segmentId && previousSegment && Math.abs(previousSegment.in - start) > 0.0005) {
      seekTo(start)
    } else if (selectedSegmentId === segmentId && currentTime > end) {
      seekTo(start)
    }
  }

  const removeTrack = (trackId: string): void => {
    setTracks((current) => current.filter((track) => track.id !== trackId))
    if (selectedId === trackId) setSelectedId(null)
  }

  const clearComplete = (): void => {
    setTracks((current) => current.filter((track) => track.analysis.status !== 'complete'))
  }

  const handleSaveIndex = async (): Promise<void> => {
    if (!selectedTrack?.analysis.result) return

    const saveResult = await window.pindex.saveIndex({
      defaultPath: makeIndexFilename(selectedTrack.name),
      contents: buildIndexFile(selectedTrack, selectedTrack.analysis.result)
    })
    if (!saveResult.canceled && saveResult.filePath) setSavedPath(saveResult.filePath)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Disc3 size={20} />
          </div>
          <div>
            <h1>pIndex</h1>
            <span>Momentum segmentation for adaptive game scores</span>
          </div>
        </div>

        <div className="toolbar">
          <button className="button secondary" onClick={handleOpenFiles}>
            <Plus size={16} />
            Add files
          </button>
          <button className="button secondary" onClick={handleOpenFolder}>
            <FolderOpen size={16} />
            Add folder
          </button>
          <button className="button" disabled={!selectedTrack} onClick={handleAnalyzeSelected}>
            <BarChart3 size={16} />
            Analyze selected
          </button>
          <button className="button primary" disabled={tracks.length === 0} onClick={handleAnalyzeAll}>
            <Activity size={16} />
            Analyze batch
          </button>
        </div>
      </header>

      <section className="workspace">
        <PlaylistPanel
          tracks={tracks}
          selectedId={selectedTrack?.id ?? null}
          completedCount={completedCount}
          analyzingCount={analyzingCount}
          queuedCount={queuedCount}
          onSelect={setSelectedId}
          onRemove={removeTrack}
          onClearComplete={clearComplete}
        />

        <TimelinePanel
          track={selectedTrack}
          audioRef={audioRef}
          currentTime={currentTime}
          isMuted={isMuted}
          isPlaying={isPlaying}
          selectedSegment={selectedSegment}
          visibleRange={visibleRange}
          volume={volume}
          onEnded={() => setIsPlaying(false)}
          onPlayPause={handlePlayPause}
          onRestart={handleRestart}
          onSeek={seekTo}
          onToggleMute={() => setIsMuted((current) => !current)}
          onVolumeChange={(nextVolume) => {
            setVolume(nextVolume)
            if (nextVolume > 0) setIsMuted(false)
          }}
          onShowFullTrack={handleClearSegmentSelection}
          onUpdateSegmentTimes={handleUpdateSegmentTimes}
        />

        <InspectorPanel
          track={selectedTrack}
          savedPath={savedPath}
          selectedSegmentId={selectedSegmentId}
          onCreateSegment={handleCreateSegment}
          onDeleteSelectedSegment={handleDeleteSelectedSegment}
          onSaveIndex={handleSaveIndex}
          onSelectSegment={handleSelectSegment}
          onUpdateSegmentTimes={handleUpdateSegmentTimes}
        />
      </section>
    </main>
  )
}

type PlaylistPanelProps = {
  tracks: Track[]
  selectedId: string | null
  completedCount: number
  analyzingCount: number
  queuedCount: number
  onSelect: (trackId: string) => void
  onRemove: (trackId: string) => void
  onClearComplete: () => void
}

function PlaylistPanel({
  tracks,
  selectedId,
  completedCount,
  analyzingCount,
  queuedCount,
  onSelect,
  onRemove,
  onClearComplete
}: PlaylistPanelProps): ReactElement {
  return (
    <aside className="panel playlist-panel">
      <div className="panel-header">
        <div>
          <h2>Playlist</h2>
          <p>{tracks.length} source files</p>
        </div>
        <button className="icon-button" disabled={completedCount === 0} onClick={onClearComplete} title="Clear completed">
          <Trash2 size={16} />
        </button>
      </div>

      <div className="batch-stats">
        <Stat label="Complete" value={completedCount.toString()} tone="green" />
        <Stat label="Active" value={(analyzingCount + queuedCount).toString()} tone="amber" />
      </div>

      <div className="track-list">
        {tracks.length === 0 ? (
          <div className="empty-state">
            <FileAudio size={30} />
            <strong>No audio files loaded</strong>
            <span>Add individual songs or scan a folder to build a batch.</span>
          </div>
        ) : (
          tracks.map((track) => (
            <button
              className={`track-row ${track.id === selectedId ? 'selected' : ''}`}
              key={track.id}
              onClick={() => onSelect(track.id)}
            >
              <span className="track-status">{statusIcon(track.analysis)}</span>
              <span className="track-copy">
                <strong>{track.name}</strong>
                <span>
                  {track.extension.replace('.', '').toUpperCase()} / {formatBytes(track.size)}
                </span>
              </span>
              <span
                className="track-remove"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(track.id)
                }}
                title="Remove file"
              >
                <Trash2 size={14} />
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}

function TimelinePanel({
  track,
  audioRef,
  currentTime,
  isMuted,
  isPlaying,
  selectedSegment,
  visibleRange,
  volume,
  onEnded,
  onPlayPause,
  onRestart,
  onSeek,
  onToggleMute,
  onUpdateSegmentTimes,
  onVolumeChange,
  onShowFullTrack
}: {
  track: Track | null
  audioRef: RefObject<HTMLAudioElement | null>
  currentTime: number
  isMuted: boolean
  isPlaying: boolean
  selectedSegment: MomentumSegment | null
  visibleRange: VisibleRange | null
  volume: number
  onEnded: () => void
  onPlayPause: () => void
  onRestart: () => void
  onSeek: (time: number) => void
  onToggleMute: () => void
  onUpdateSegmentTimes: (segmentId: string, nextIn: number, nextOut: number) => void
  onVolumeChange: (volume: number) => void
  onShowFullTrack: () => void
}): ReactElement {
  const analysis = track?.analysis
  const result = analysis?.result

  return (
    <section className="panel timeline-panel">
      <div className="timeline-top">
        <div>
          <h2>{track?.name ?? 'Select an audio file'}</h2>
          <p>
            {track
              ? `${track.path} / ${track.analysis.status}${selectedSegment ? ` / looping ${selectedSegment.label}` : ''}`
              : 'Load files to inspect waveform energy and generate segment indexes.'}
          </p>
        </div>
        <div className="transport-actions">
          <VolumeControl
            isMuted={isMuted}
            volume={volume}
            onToggleMute={onToggleMute}
            onVolumeChange={onVolumeChange}
          />
          <button className="icon-button" disabled={!track} onClick={onRestart} title="Return to zero">
            <RotateCcw size={16} />
          </button>
          <button
            className="icon-button primary-icon"
            disabled={!track || analysis?.status === 'analyzing'}
            onClick={onPlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {analysis?.status === 'analyzing' ? (
              <Loader2 className="spinning" size={16} />
            ) : isPlaying ? (
              <Pause size={16} />
            ) : (
              <Play size={16} />
            )}
          </button>
        </div>
      </div>

      {track ? (
        <audio
          ref={audioRef}
          className="hidden-audio"
          onEnded={onEnded}
          onPause={() => onEnded()}
          onPlay={() => undefined}
        />
      ) : null}

      <div className="analysis-canvas">
        {result && visibleRange ? (
          <Waveform
            currentTime={currentTime}
            selectedSegment={selectedSegment}
            result={result}
            selectedSegmentId={selectedSegment?.id ?? null}
            visibleRange={visibleRange}
            onSeek={onSeek}
            onTrimSegment={onUpdateSegmentTimes}
          />
        ) : (
          <div className="empty-analysis">
            <Music2 size={42} />
            <strong>{analysis?.status === 'analyzing' ? 'Reading momentum profile' : 'No index generated yet'}</strong>
            <span>
              {analysis?.status === 'analyzing'
                ? `${formatPercent(analysis.progress)} complete`
                : 'Press play or run analysis to detect energy bands and usable loop segments.'}
            </span>
            {analysis?.status === 'analyzing' ? <ProgressBar value={analysis.progress} /> : null}
          </div>
        )}
      </div>

      <div className="metric-strip">
        <Metric label="Time" value={formatTime(currentTime)} />
        <Metric
          label="View"
          value={selectedSegment && result ? `${formatTime(selectedSegment.duration)}` : result ? 'Full track' : '-'}
        />
        <Metric label="Avg energy" value={result ? formatPercent(result.averageEnergy) : '-'} />
        <Metric label="Segments" value={result ? result.segments.length.toString() : '-'} />
      </div>

      {selectedSegment ? (
        <div className="focused-segment-bar">
          <span>
            Looping {selectedSegment.label}: {formatTime(selectedSegment.in)} to {formatTime(selectedSegment.out)}
          </span>
          <button className="text-button" onClick={onShowFullTrack}>
            Show full track
          </button>
        </div>
      ) : null}
    </section>
  )
}

function VolumeControl({
  isMuted,
  volume,
  onToggleMute,
  onVolumeChange
}: {
  isMuted: boolean
  volume: number
  onToggleMute: () => void
  onVolumeChange: (volume: number) => void
}): ReactElement {
  return (
    <div className="volume-control">
      <input
        aria-label="Volume"
        max="1"
        min="0"
        step="0.01"
        type="range"
        value={volume}
        onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
      />
      <button className="volume-button" onClick={onToggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
        {isMuted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  )
}

function Waveform({
  currentTime,
  result,
  selectedSegment,
  selectedSegmentId,
  visibleRange,
  onSeek,
  onTrimSegment
}: {
  currentTime: number
  result: AnalysisResult
  selectedSegment: MomentumSegment | null
  selectedSegmentId: string | null
  visibleRange: VisibleRange
  onSeek: (time: number) => void
  onTrimSegment: (segmentId: string, nextIn: number, nextOut: number) => void
}): ReactElement {
  const [draggingEdge, setDraggingEdge] = useState<'in' | 'out' | null>(null)
  const trimDragSessionRef = useRef<TrimDragSession | null>(null)
  const suppressNextClickRef = useRef(false)
  const width = 980
  const height = 300
  const rangeDuration = Math.max(visibleRange.end - visibleRange.start, 0.001)
  const points = result.waveform.filter(
    (point) => point.time >= visibleRange.start && point.time <= visibleRange.end
  )
  const displayPoints = points.length > 1 ? points : result.waveform
  const xForTime = (time: number): number => ((time - visibleRange.start) / rangeDuration) * width
  const yForEnergy = (energy: number): number => height - energy * height * 0.82 - 18
  const yForMomentum = (momentum: number): number => height - momentum * height * 0.76 - 24

  const areaPath = displayPoints
    .map((point, index) => {
      const x = xForTime(point.time)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${yForEnergy(point.energy).toFixed(2)}`
    })
    .join(' ')

  const momentumPath = displayPoints
    .map((point, index) => {
      const x = xForTime(point.time)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${yForMomentum(point.momentum).toFixed(2)}`
    })
    .join(' ')

  const playheadX = clamp(xForTime(currentTime), 0, width)

  const timeForPointer = (event: PointerEvent<SVGSVGElement | SVGGElement>, range = visibleRange): number => {
    const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement
    if (!svg) return range.start
    const rect = svg.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / rect.width
    return range.start + ratio * Math.max(range.end - range.start, 0.001)
  }

  const trimSelectedSegment = (edge: 'in' | 'out', time: number): void => {
    const session = trimDragSessionRef.current
    if (!selectedSegment || !session) return
    if (edge === 'in') {
      onTrimSegment(selectedSegment.id, time, session.originalOut)
      return
    }
    onTrimSegment(selectedSegment.id, session.originalIn, time)
  }

  const handleClick = (event: MouseEvent<SVGSVGElement>): void => {
    if (draggingEdge || suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = clamp((event.clientX - rect.left) / rect.width)
    onSeek(visibleRange.start + ratio * rangeDuration)
  }

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const session = trimDragSessionRef.current
    if (!draggingEdge || !session) return
    trimSelectedSegment(draggingEdge, timeForPointer(event, session.range))
  }

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    const session = trimDragSessionRef.current
    if (!draggingEdge || !session) return
    trimSelectedSegment(draggingEdge, timeForPointer(event, session.range))
    trimDragSessionRef.current = null
    setDraggingEdge(null)
  }

  const handleTrimPointerDown = (edge: 'in' | 'out', event: PointerEvent<SVGGElement>): void => {
    if (!selectedSegment) return
    suppressNextClickRef.current = true
    trimDragSessionRef.current = {
      edge,
      range: { ...visibleRange },
      originalIn: selectedSegment.in,
      originalOut: selectedSegment.out
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingEdge(edge)
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Energy and momentum waveform"
      onClick={handleClick}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={`waveform ${draggingEdge ? 'trimming' : ''}`}
    >
      <defs>
        <linearGradient id="energyFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#39d2ff" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#39d2ff" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect width={width} height={height} rx="14" fill="#0b0f14" />
      {[0.25, 0.5, 0.75].map((line) => (
        <line
          key={line}
          x1="0"
          x2={width}
          y1={height * line}
          y2={height * line}
          stroke="#26313d"
          strokeDasharray="6 8"
        />
      ))}
      {result.segments
        .filter((segment) => segment.out >= visibleRange.start && segment.in <= visibleRange.end)
        .map((segment, index) => {
          const segmentStart = Math.max(segment.in, visibleRange.start)
          const segmentEnd = Math.min(segment.out, visibleRange.end)
          const x = xForTime(segmentStart)
          const segmentWidth = Math.max(((segmentEnd - segmentStart) / rangeDuration) * width, 2)
          return (
            <g key={segment.id}>
              <rect
                x={x}
                y="0"
                width={segmentWidth}
                height={height}
                className={`segment-band segment-${segment.band} ${
                  segment.id === selectedSegmentId ? 'selected-wave-segment' : ''
                }`}
                opacity={segment.id === selectedSegmentId ? 0.34 : index % 2 === 0 ? 0.22 : 0.14}
              />
              <text x={x + 10} y="26" className="segment-label">
                {segment.label}
              </text>
            </g>
          )
        })}
      <path d={`${areaPath} L ${width} ${height} L 0 ${height} Z`} fill="url(#energyFill)" />
      <path d={areaPath} fill="none" stroke="#39d2ff" strokeWidth="2.5" />
      <path d={momentumPath} fill="none" stroke="#f2b94b" strokeWidth="2" opacity="0.9" />
      {selectedSegment ? (
        <>
          <TrimHandle edge="in" onPointerDown={(event) => handleTrimPointerDown('in', event)} />
          <TrimHandle edge="out" onPointerDown={(event) => handleTrimPointerDown('out', event)} />
        </>
      ) : null}
      <line className="playhead" x1={playheadX} x2={playheadX} y1="0" y2={height} />
      <circle className="playhead-handle" cx={playheadX} cy="18" r="5" />
    </svg>
  )
}

function TrimHandle({
  edge,
  onPointerDown
}: {
  edge: 'in' | 'out'
  onPointerDown: (event: PointerEvent<SVGGElement>) => void
}): ReactElement {
  const x = edge === 'in' ? 6 : 974
  const direction = edge === 'in' ? 1 : -1
  const points = `${x + direction * 12},40 ${x},40 ${x},260 ${x + direction * 12},260`

  return (
    <g
      className={`trim-handle trim-handle-${edge}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        onPointerDown(event)
      }}
    >
      <polyline points={points} />
      <rect x={edge === 'in' ? 0 : 956} y="34" width="24" height="232" />
    </g>
  )
}

function InspectorPanel({
  track,
  savedPath,
  selectedSegmentId,
  onCreateSegment,
  onDeleteSelectedSegment,
  onSaveIndex,
  onSelectSegment,
  onUpdateSegmentTimes
}: {
  track: Track | null
  savedPath: string | null
  selectedSegmentId: string | null
  onCreateSegment: () => void
  onDeleteSelectedSegment: () => void
  onSaveIndex: () => void
  onSelectSegment: (segment: MomentumSegment) => void
  onUpdateSegmentTimes: (segmentId: string, nextIn: number, nextOut: number) => void
}): ReactElement {
  const result = track?.analysis.result

  return (
    <aside className="panel inspector-panel">
      <div className="panel-header">
        <div>
          <h2>Index</h2>
          <p>{result ? 'Ready to export' : 'Awaiting analysis'}</p>
        </div>
        <button className="icon-button primary-icon" disabled={!result} onClick={onSaveIndex} title="Save index">
          <Save size={16} />
        </button>
      </div>

      {track?.analysis.status === 'error' ? <div className="error-box">{track.analysis.error}</div> : null}

      <div className="export-box">
        <Download size={18} />
        <div>
          <strong>{result ? makeIndexFilename(track.name) : 'No index file'}</strong>
          <span>{savedPath ?? 'Analyze a track, then save a segment index.'}</span>
        </div>
      </div>

      <div className="segments-header">
        <span>Segments</span>
        <div className="segment-header-actions">
          <span>{result?.segments.length ?? 0}</span>
          <button className="mini-icon-button" disabled={!result} onClick={onCreateSegment} title="Create segment">
            <Plus size={14} />
          </button>
          <button
            className="mini-icon-button danger"
            disabled={!result || !selectedSegmentId}
            onClick={onDeleteSelectedSegment}
            title="Discard selected segment"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="segment-list">
        {result ? (
          result.segments.map((segment) => (
            <SegmentRow
              key={segment.id}
              segment={segment}
              selected={segment.id === selectedSegmentId}
              onSelect={() => onSelectSegment(segment)}
              onUpdateTimes={(nextIn, nextOut) => onUpdateSegmentTimes(segment.id, nextIn, nextOut)}
            />
          ))
        ) : (
          <div className="empty-state small">
            <Activity size={24} />
            <strong>Energy bands will appear here</strong>
            <span>Each row becomes a cueable segment in the exported JSON.</span>
          </div>
        )}
      </div>
    </aside>
  )
}

function SegmentRow({
  segment,
  selected,
  onSelect,
  onUpdateTimes
}: {
  segment: MomentumSegment
  selected: boolean
  onSelect: () => void
  onUpdateTimes: (nextIn: number, nextOut: number) => void
}): ReactElement {
  const [draftIn, setDraftIn] = useState(segment.in.toFixed(3))
  const [draftOut, setDraftOut] = useState(segment.out.toFixed(3))

  useEffect(() => {
    if (!selected) return
    setDraftIn(segment.in.toFixed(3))
    setDraftOut(segment.out.toFixed(3))
  }, [segment.id, segment.in, segment.out, selected])

  const commitDraft = (): void => {
    const nextIn = Number(draftIn)
    const nextOut = Number(draftOut)
    if (!Number.isFinite(nextIn) || !Number.isFinite(nextOut)) {
      setDraftIn(segment.in.toFixed(3))
      setDraftOut(segment.out.toFixed(3))
      return
    }
    onUpdateTimes(nextIn, nextOut)
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    }
    if (event.key === 'Escape') {
      setDraftIn(segment.in.toFixed(3))
      setDraftOut(segment.out.toFixed(3))
      event.currentTarget.blur()
    }
  }

  return (
    <div className={`segment-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="segment-title">
        <span className={`band-dot ${segment.band}`} />
        <strong>{segment.label}</strong>
        <span>{formatPercent(segment.confidence)}</span>
      </div>
      <div className="segment-values">
        <span>{formatTime(segment.in)}</span>
        <span>{formatTime(segment.out)}</span>
        <span>E {formatPercent(segment.energy)}</span>
        <span>M {formatPercent(segment.momentum)}</span>
      </div>
      {selected ? (
        <div className="segment-editors" onClick={(event) => event.stopPropagation()}>
          <label>
            In
            <input
              min="0"
              step="0.1"
              type="number"
              value={draftIn}
              onBlur={commitDraft}
              onChange={(event) => setDraftIn(event.currentTarget.value)}
              onKeyDown={handleEditorKeyDown}
            />
          </label>
          <label>
            Out
            <input
              min="0"
              step="0.1"
              type="number"
              value={draftOut}
              onBlur={commitDraft}
              onChange={(event) => setDraftOut(event.currentTarget.value)}
              onKeyDown={handleEditorKeyDown}
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'green' | 'amber' }): ReactElement {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ProgressBar({ value }: { value: number }): ReactElement {
  return (
    <div className="progress">
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}
