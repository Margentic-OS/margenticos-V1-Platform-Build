'use client'

// File upload section for the intake form.
// Accepts PDF, DOCX, TXT, and MD files up to 10MB each.
// Purpose selector routes each file to the right agent:
//   voice_sample → TOV agent
//   icp_doc      → ICP agent
//   case_study   → ICP and positioning agents
//   other        → stored but not actively consumed yet
//
// Upload state is local — no global state management needed.
// Drag-and-drop is a progressive enhancement; the browse button is the primary action.

import { useState, useRef, useCallback, useTransition } from 'react'
import type { IntakeFileRecord } from '@/app/intake/actions'

type FilePurpose = 'voice_sample' | 'icp_doc' | 'case_study' | 'other'

const PURPOSE_LABELS: Record<FilePurpose, string> = {
  voice_sample: 'Writing Sample',
  icp_doc:      'ICP Document',
  case_study:   'Case Study',
  other:        'Other',
}

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md']
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]
const MAX_BYTES = 10 * 1024 * 1024

interface PendingUpload {
  file: File
  purpose: FilePurpose
  uploading: boolean
  error: string | null
}

interface FileUploadSectionProps {
  initialFiles: IntakeFileRecord[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extensionFromMime(mime: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'text/plain': 'TXT',
    'text/markdown': 'MD',
  }
  return map[mime] ?? mime
}

export default function FileUploadSection({ initialFiles }: FileUploadSectionProps) {
  const [uploadedFiles, setUploadedFiles] = useState<IntakeFileRecord[]>(initialFiles)
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return `${file.name}: Only PDF, DOCX, TXT, and MD files are accepted.`
    }
    if (file.size > MAX_BYTES) {
      return `${file.name}: File exceeds the 10MB limit (${formatBytes(file.size)}).`
    }
    return null
  }

  const uploadFile = useCallback((pending: PendingUpload) => {
    startTransition(async () => {
      // Mark as uploading
      setPendingUploads(prev =>
        prev.map(p => p.file === pending.file ? { ...p, uploading: true, error: null } : p)
      )

      const formData = new FormData()
      formData.append('file', pending.file)
      formData.append('file_purpose', pending.purpose)

      try {
        const res = await fetch('/api/intake/files/upload', {
          method: 'POST',
          body: formData,
        })

        const body = await res.json() as { file?: IntakeFileRecord; error?: string }

        if (!res.ok || !body.file) {
          setPendingUploads(prev =>
            prev.map(p =>
              p.file === pending.file
                ? { ...p, uploading: false, error: body.error ?? 'Upload failed. Try again.' }
                : p
            )
          )
          return
        }

        // Success — move from pending to uploaded list
        setUploadedFiles(prev => [body.file!, ...prev])
        setPendingUploads(prev => prev.filter(p => p.file !== pending.file))

      } catch {
        setPendingUploads(prev =>
          prev.map(p =>
            p.file === pending.file
              ? { ...p, uploading: false, error: 'Upload failed. Check your connection and try again.' }
              : p
          )
        )
      }
    })
  }, [startTransition])

  const addFiles = useCallback((files: FileList | File[]) => {
    const newPending: PendingUpload[] = []
    const validationErrors: string[] = []

    for (const file of Array.from(files)) {
      const error = validateFile(file)
      if (error) {
        validationErrors.push(error)
      } else {
        newPending.push({ file, purpose: 'voice_sample', uploading: false, error: null })
      }
    }

    if (validationErrors.length > 0) {
      // Show validation errors briefly — add as failed pending items
      const errorItems: PendingUpload[] = validationErrors.map((err, i) => ({
        file: new File([], `error-${i}`),
        purpose: 'voice_sample',
        uploading: false,
        error: err,
      }))
      setPendingUploads(prev => [...prev, ...errorItems])
    }

    setPendingUploads(prev => [...prev, ...newPending])
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files)
    }
    // Reset input so the same file can be re-selected after an error
    e.target.value = ''
  }, [addFiles])

  const handlePurposeChange = useCallback((file: File, purpose: FilePurpose) => {
    setPendingUploads(prev =>
      prev.map(p => p.file === file ? { ...p, purpose } : p)
    )
  }, [])

  const handleDeleteUploaded = useCallback((fileId: string) => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/intake/files/${fileId}`, { method: 'DELETE' })
        if (res.ok) {
          setUploadedFiles(prev => prev.filter(f => f.id !== fileId))
        }
      } catch {
        // Silent fail on delete — the file remains in the list
      }
    })
  }, [startTransition])

  const removePending = useCallback((file: File) => {
    setPendingUploads(prev => prev.filter(p => p.file !== file))
  }, [])

  const cardBase = 'bg-surface-card border border-border-card rounded-[10px] p-4 sm:p-5'
  const btnSecondary = 'px-3 py-1.5 text-[11px] font-medium rounded-[6px] border border-border-card bg-surface-content text-text-secondary hover:text-text-primary transition-colors'

  return (
    <div className={cardBase}>
      <p className="text-xs font-medium text-text-primary mb-1">
        Upload reference documents
        <span className="ml-1 text-text-muted font-normal text-[11px]">(optional)</span>
      </p>
      <p className="text-[11px] text-text-muted mb-4 leading-relaxed">
        Upload writing samples, an existing ICP document, or case studies.
        Supported formats: PDF, DOCX, TXT, MD. Max 10MB per file.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={[
          'border-2 border-dashed rounded-[8px] px-4 py-6 text-center transition-colors mb-4',
          isDragging
            ? 'border-brand-green bg-[#EBF5E6]'
            : 'border-border-card bg-surface-content',
        ].join(' ')}
      >
        <p className="text-[11px] text-text-muted mb-2">
          Drag files here, or
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-4 py-2 text-xs font-medium rounded-[6px] bg-brand-green text-[#F5F0E8] hover:opacity-90 transition-opacity"
        >
          Browse files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS.join(',')}
          onChange={handleInputChange}
          className="hidden"
          aria-label="Upload files"
        />
      </div>

      {/* Pending uploads — awaiting purpose selection or in progress */}
      {pendingUploads.length > 0 && (
        <div className="space-y-2 mb-4">
          {pendingUploads.map((pending, i) => (
            <div
              key={`${pending.file.name}-${i}`}
              className="flex items-start gap-3 bg-surface-content border border-border-card rounded-[8px] px-3 py-3"
            >
              <div className="flex-1 min-w-0">
                {pending.error ? (
                  <p className="text-[11px] text-red-500 leading-relaxed">{pending.error}</p>
                ) : (
                  <>
                    <p className="text-[11px] font-medium text-text-primary truncate mb-1.5">
                      {pending.file.name}
                      <span className="ml-1 text-text-muted font-normal">
                        {formatBytes(pending.file.size)}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <select
                        value={pending.purpose}
                        onChange={e => handlePurposeChange(pending.file, e.target.value as FilePurpose)}
                        disabled={pending.uploading}
                        className="text-[11px] px-2 py-1 bg-surface-card border border-border-card rounded-[4px] text-text-primary focus:outline-none focus:border-brand-green-accent disabled:opacity-50"
                      >
                        {(Object.entries(PURPOSE_LABELS) as [FilePurpose, string][]).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      {!pending.uploading && (
                        <button
                          type="button"
                          onClick={() => uploadFile(pending)}
                          className="px-2.5 py-1 text-[11px] font-medium rounded-[4px] bg-brand-green text-[#F5F0E8] hover:opacity-90 transition-opacity"
                        >
                          Upload
                        </button>
                      )}
                      {pending.uploading && (
                        <span className="text-[11px] text-text-muted">Uploading…</span>
                      )}
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => removePending(pending.file)}
                disabled={pending.uploading}
                aria-label="Remove"
                className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-30 mt-0.5 shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Uploaded files */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted font-medium mb-1">
            Uploaded files
          </p>
          {uploadedFiles.map(file => (
            <div
              key={file.id}
              className="flex items-center gap-3 bg-surface-content border border-border-card rounded-[8px] px-3 py-2.5"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-text-primary truncate">
                  {file.original_filename}
                </p>
                <p className="text-[10px] text-text-muted mt-0.5">
                  {extensionFromMime(file.mime_type)} · {formatBytes(file.file_size_bytes)} · {PURPOSE_LABELS[file.file_purpose]}
                  {file.extraction_status === 'failed' && (
                    <span className="ml-1.5 text-amber-600">· Text extraction failed — file won't be read by agents</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteUploaded(file.id)}
                aria-label={`Delete ${file.original_filename}`}
                className={`${btnSecondary} shrink-0`}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadedFiles.length === 0 && pendingUploads.length === 0 && (
        <p className="text-[11px] text-text-muted text-center py-1">
          No files uploaded yet.
        </p>
      )}
    </div>
  )
}
