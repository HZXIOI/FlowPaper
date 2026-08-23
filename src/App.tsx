import { useState, useEffect, useRef, useCallback } from 'react'
import {
  FolderOpen,
  FileVideo,
  Play,
  Pause,
  ImageIcon,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Film,
  Upload,
  ExternalLink,
  RefreshCw
} from 'lucide-react'

interface VideoItem {
  name: string
  path: string
  size: number
  modified: number
  thumbnail: string
}

function App() {
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null)
  const [wallpaperFolder, setWallpaperFolder] = useState<string>('')
  const [opacity, setOpacity] = useState<number>(20)
  const [isPlaying, setIsPlaying] = useState(false)
  const [status, setStatus] = useState<{ message: string; type: 'info' | 'success' | 'error' | 'loading' } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const statusTimerRef = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const showStatus = useCallback((message: string, type: 'info' | 'success' | 'error' | 'loading') => {
    setStatus({ message, type })
    if (statusTimerRef.current) {
      window.clearTimeout(statusTimerRef.current)
    }
    if (type !== 'loading') {
      statusTimerRef.current = window.setTimeout(() => {
        setStatus(null)
      }, 3000)
    }
  }, [])

  useEffect(() => {
    if (window.electronAPI) {
      const cleanup = window.electronAPI.onProgress((message: string) => {
        showStatus(message, 'loading')
      })
      return cleanup
    }
  }, [showStatus])

  useEffect(() => {
    const init = async () => {
      if (window.electronAPI) {
        const folder = await window.electronAPI.getDefaultFolder()
        setWallpaperFolder(folder)
        await window.electronAPI.ensureFolder(folder)
        await loadVideosFromFolder(folder)
      }
    }
    init()
  }, [])

  useEffect(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.play().catch(() => {})
      } else {
        videoRef.current.pause()
      }
    }
  }, [isPlaying, selectedVideo])

  const loadVideosFromFolder = async (folder: string) => {
    if (!folder || !window.electronAPI) return
    let items = await window.electronAPI.getVideosFromFolder(folder)
    // 发现缺失封面的视频时，批量生成封面后刷新
    if (items.some(v => !v.thumbnail)) {
      items = await window.electronAPI.generateThumbnails(folder)
    }
    setVideos(items)
    if (selectedVideo) {
      const stillExists = items.some(v => v.path === selectedVideo.path)
      if (!stillExists) {
        setSelectedVideo(items[0] ?? null)
      }
    } else if (items.length > 0) {
      setSelectedVideo(items[0])
    } else {
      setSelectedVideo(null)
    }
  }

  const handleSelectFolder = async () => {
    if (!window.electronAPI) return
    const folder = await window.electronAPI.selectWallpaperFolder()
    if (folder) {
      setWallpaperFolder(folder)
      await window.electronAPI.ensureFolder(folder)
      await loadVideosFromFolder(folder)
    }
  }

  const handleOpenFolder = async () => {
    if (!wallpaperFolder || !window.electronAPI) return
    await window.electronAPI.openFolder(wallpaperFolder)
  }

  const handleRefresh = async () => {
    if (!wallpaperFolder) return
    await loadVideosFromFolder(wallpaperFolder)
    showStatus('视频库已刷新', 'success')
  }

  const handleSelectVideo = async () => {
    if (!window.electronAPI || !wallpaperFolder) return
    const sourcePath = await window.electronAPI.selectVideo()
    if (!sourcePath) return

    showStatus('正在导入视频...', 'loading')
    const result = await window.electronAPI.importVideo({
      sourcePath,
      folderPath: wallpaperFolder
    })

    if (result.success && result.item) {
      await loadVideosFromFolder(wallpaperFolder)
      setSelectedVideo(result.item)
      showStatus('视频已导入到壁纸库', 'success')
    } else {
      showStatus(result.message || '导入失败', 'error')
    }
  }

  const handleApply = async () => {
    if (!selectedVideo || !window.electronAPI) return
    showStatus('正在应用壁纸...', 'loading')
    const result = await window.electronAPI.applyWallpaper({
      videoPath: selectedVideo.path,
      opacity
    })
    if (result.success) {
      showStatus(result.message, 'success')
    } else {
      showStatus(result.message, 'error')
    }
  }

  const handleRestore = async () => {
    if (!window.electronAPI) return
    showStatus('正在恢复默认...', 'loading')
    const result = await window.electronAPI.restoreDefault()
    showStatus(result.message, result.success ? 'success' : 'error')
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-'
    const mb = bytes / 1024 / 1024
    return `${mb.toFixed(1)} MB`
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (!window.electronAPI || !wallpaperFolder) return

    const files = Array.from(e.dataTransfer.files)
    const videoFiles = files.filter(f => /\.(mp4|webm|mov|mkv|avi)$/i.test(f.name))

    if (videoFiles.length === 0) {
      showStatus('请拖入视频文件', 'error')
      return
    }

    showStatus(`正在导入 ${videoFiles.length} 个视频...`, 'loading')
    let importedItem: VideoItem | null = null

    for (const file of videoFiles) {
      const result = await window.electronAPI.importVideo({
        sourcePath: file.path,
        folderPath: wallpaperFolder
      })
      if (result.success && result.item) {
        importedItem = result.item
      } else {
        showStatus(result.message || '导入失败', 'error')
        return
      }
    }

    await loadVideosFromFolder(wallpaperFolder)
    if (importedItem) {
      setSelectedVideo(importedItem)
    }
    showStatus('视频已导入到壁纸库', 'success')
  }, [wallpaperFolder, showStatus])

  const getPreviewSrc = (video: VideoItem) => {
    const normalized = video.path.replace(/\\/g, '/')
    return `file:///${encodeURI(normalized)}`
  }

  const getThumbnailSrc = (video: VideoItem) => {
    const normalized = video.thumbnail.replace(/\\/g, '/')
    return `file:///${encodeURI(normalized)}`
  }

  return (
    <div
      className="app"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Sidebar */}
      <div className="sidebar">
        <div className="panel library-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">视频库</div>
              <div className="panel-subtitle">{videos.length} 个视频</div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-secondary" style={{ flex: 'none', padding: '8px' }} onClick={handleRefresh} title="刷新列表">
                <RefreshCw size={16} />
              </button>
              <button className="btn btn-secondary" style={{ flex: 'none', padding: '8px' }} onClick={handleOpenFolder} title="打开文件夹">
                <ExternalLink size={16} />
              </button>
              <button className="btn btn-secondary" style={{ flex: 'none', padding: '8px' }} onClick={handleSelectFolder} title="切换文件夹">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
          <div className="video-list">
            {videos.length === 0 ? (
              <div className="empty-state">
                <Film size={48} />
                <div>暂无视频</div>
                <div className="panel-subtitle">点击右上角选择文件夹，或拖入视频</div>
              </div>
            ) : (
              videos.map(video => (
                <div
                  key={video.path}
                  className={`video-item ${selectedVideo?.path === video.path ? 'active' : ''}`}
                  onClick={() => setSelectedVideo(video)}
                >
                  <div className="video-thumbnail">
                    {video.thumbnail ? (
                      <img src={getThumbnailSrc(video)} alt={video.name} draggable={false} />
                    ) : (
                      <FileVideo />
                    )}
                  </div>
                  <div className="video-info">
                    <div className="video-name">{video.name}</div>
                    <div className="video-meta">{formatSize(video.size)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        <div className="panel preview-panel">
          <div className="preview-header">
            <div className="preview-title">预览</div>
          </div>
          <div className="preview-container">
            <div className="video-wrapper">
              {selectedVideo ? (
                <video
                  ref={videoRef}
                  src={getPreviewSrc(selectedVideo)}
                  loop
                  muted
                  playsInline
                  autoPlay
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
              ) : (
                <div className="preview-placeholder">
                  <ImageIcon />
                  <div>选择一个视频开始预览</div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="panel controls-panel">
          <div className="control-group">
            <div className="control-label">
              <span>壁纸库文件夹</span>
              <button className="btn btn-secondary" style={{ flex: 'none', padding: '4px 8px', fontSize: '12px' }} onClick={handleOpenFolder}>
                <ExternalLink size={12} />
                打开
              </button>
            </div>
            <div className="path-display">
              {wallpaperFolder || '未设置'}
            </div>
          </div>

          <div className="control-group">
            <div className="control-label">
              <span>当前选中</span>
            </div>
            <div className="path-display">
              {selectedVideo ? selectedVideo.path : '未选择视频'}
            </div>
          </div>

          <div className="control-group">
            <div className="control-label">
              <span>背景透明度</span>
              <span className="control-value">{opacity}%</span>
            </div>
            <input
              type="range"
              className="slider"
              min={5}
              max={60}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </div>

          <div className="buttons">
            <button className="btn btn-secondary" onClick={handleSelectVideo}>
              <Upload size={18} />
              导入视频
            </button>
            {selectedVideo && (
              <button className="btn btn-secondary" onClick={() => setIsPlaying(!isPlaying)}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                {isPlaying ? '暂停' : '播放'}
              </button>
            )}
            <button className="btn btn-danger" onClick={handleRestore}>
              <RotateCcw size={18} />
              恢复默认
            </button>
            <button className="btn btn-primary" onClick={handleApply} disabled={!selectedVideo}>
              <CheckCircle2 size={18} />
              应用到 Trae
            </button>
          </div>
        </div>
      </div>

      {/* Status Bar */}
      {status && (
        <div className={`status-bar ${status.type}`}>
          {status.type === 'loading' && <div className="loading-spinner" />}
          {status.type === 'success' && <CheckCircle2 size={14} />}
          {status.type === 'error' && <AlertCircle size={14} />}
          {status.message}
        </div>
      )}

      {/* Drag Overlay */}
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">拖入视频文件</div>
        </div>
      )}
    </div>
  )
}

export default App
