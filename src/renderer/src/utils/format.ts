export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  const milliseconds = Math.round((seconds % 1) * 1000)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${milliseconds
    .toString()
    .padStart(3, '0')}`
}

export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`

export const makeIndexFilename = (name: string): string => {
  const baseName = name.replace(/\.[^/.]+$/, '')
  return `${baseName}.pindex.json`
}
