import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

type IconName =
  | 'search'
  | 'chevron'
  | 'bell'
  | 'plus'
  | 'external'
  | 'trash'
  | 'globe'
  | 'key'
  | 'home'
  | 'notes'
  | 'pin'
  | 'check'
  | 'calendar'
  | 'clock'
  | 'edit'
type AuthMode = 'login' | 'register'
type WorkspacePage = 'dashboard' | 'notes' | 'calendar' | 'notifications'

type User = {
  id: string
  username: string
  email: string
}

type AuthResponse = {
  user?: User | null
  error?: string
}

type Shortcut = {
  id: string
  name: string
  url: string
  icon_data: string | null
}

type ShortcutsResponse = {
  shortcuts?: Shortcut[]
  shortcut?: Shortcut
  error?: string
}

type Note = {
  id: string
  title: string
  content: string
  pinned: boolean
  updated_at: number
}

type NotesResponse = {
  notes?: Note[]
  note?: Note
  error?: string
}

type Task = {
  id: string
  text: string
  completed: boolean
  created_at: number
}

type TasksResponse = {
  tasks?: Task[]
  task?: Task
  error?: string
}

type CalendarEvent = {
  id: string
  title: string
  description: string
  color: string
  event_type: 'event' | 'class'
  schedule: 'once' | 'weekly'
  event_date: string | null
  start_date: string | null
  end_date: string | null
  weekdays: number[]
  start_time: string | null
  end_time: string | null
  reminder_days: number
}

type CalendarEventsResponse = {
  events?: CalendarEvent[]
  event?: CalendarEvent
  error?: string
}

type CalendarEventDraft = Omit<CalendarEvent, 'id'>

type CalendarReminder = {
  event: CalendarEvent
  occurrenceDate: string
  reminderDate: string
}

type UniversityTokenStatus = {
  enabled: boolean
  saved: boolean
  updated_at: number | null
  error?: string
}

const CACHED_USER_KEY = 'studyspace.cached-user'
const CALENDAR_COLORS = [
  { value: '#bda7f5', label: 'Lavender' },
  { value: '#f2a6a0', label: 'Coral' },
  { value: '#f2c879', label: 'Amber' },
  { value: '#83c9ad', label: 'Mint' },
  { value: '#83b8e8', label: 'Blue' },
  { value: '#d99bc8', label: 'Pink' },
]
const WEEKDAYS = [
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
  { value: 7, short: 'Sun', label: 'Sunday' },
]

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseLocalDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function shiftDate(date: string, days: number): string {
  const shifted = parseLocalDate(date)
  shifted.setDate(shifted.getDate() + days)
  return localDateString(shifted)
}

function formatCalendarDate(date: string, options?: Intl.DateTimeFormatOptions): string {
  return parseLocalDate(date).toLocaleDateString(undefined, options ?? {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatReminderDate(date: string, today: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number)
  const dayDifference = (
    Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)
  ) / 86_400_000
  if (dayDifference === 0) return 'Today'
  if (dayDifference === 1) return 'Tomorrow'
  return `In ${dayDifference} days`
}

function eventOccursOnDate(event: CalendarEvent, date: string): boolean {
  if (event.schedule === 'once') return event.event_date === date
  if (!event.start_date || !event.end_date || date < event.start_date || date > event.end_date) return false
  const weekday = parseLocalDate(date).getDay() || 7
  return event.weekdays.includes(weekday)
}

function getCalendarReminders(events: CalendarEvent[], today = localDateString(new Date())): CalendarReminder[] {
  const reminders: CalendarReminder[] = []
  for (const event of events) {
    if (event.reminder_days === 0) continue
    for (let offset = 0; offset <= 60; offset += 1) {
      const occurrenceDate = shiftDate(today, offset)
      if (!eventOccursOnDate(event, occurrenceDate)) continue
      const reminderDate = shiftDate(occurrenceDate, -event.reminder_days)
      if (reminderDate >= today && reminderDate <= shiftDate(today, 30)) {
        reminders.push({ event, occurrenceDate, reminderDate })
      }
    }
  }
  return reminders.sort((a, b) =>
    a.reminderDate.localeCompare(b.reminderDate)
      || a.occurrenceDate.localeCompare(b.occurrenceDate)
      || a.event.title.localeCompare(b.event.title),
  )
}

function workspacePageFromPath(pathname: string): WorkspacePage {
  if (pathname === '/notes') return 'notes'
  if (pathname === '/calendar') return 'calendar'
  if (pathname === '/notifications') return 'notifications'
  return 'dashboard'
}

function makeCalendarDraft(date: string): CalendarEventDraft {
  return {
    title: '',
    description: '',
    color: CALENDAR_COLORS[0].value,
    event_type: 'event',
    schedule: 'once',
    event_date: date,
    start_date: date,
    end_date: shiftDate(date, 90),
    weekdays: [],
    start_time: null,
    end_time: null,
    reminder_days: 0,
  }
}

function getCalendarMonthDates(month: Date): string[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (firstDay.getDay() + 6) % 7
  const firstCell = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - offset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell)
    date.setDate(firstCell.getDate() + index)
    return localDateString(date)
  })
}

async function readApiResponse<T extends { error?: string }>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const responseBody = await response.text()
  let result: T

  try {
    result = JSON.parse(responseBody) as T
  } catch {
    const detail = responseBody.trim()
      ? `The server returned an invalid response (HTTP ${response.status}).`
      : `The server returned an empty response (HTTP ${response.status}).`
    throw new Error(`${detail} Make sure the backend is running with ./run_backend.sh.`)
  }

  if (!response.ok) {
    throw new Error(result.error ?? fallbackMessage)
  }
  return result
}

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'username' in value &&
    typeof value.username === 'string' &&
    'email' in value &&
    typeof value.email === 'string'
  )
}

function readCachedUser(): User | null {
  try {
    const storedUser = localStorage.getItem(CACHED_USER_KEY)
    if (!storedUser) return null

    const parsedUser: unknown = JSON.parse(storedUser)
    if (isUser(parsedUser)) return parsedUser

    localStorage.removeItem(CACHED_USER_KEY)
    return null
  } catch (storageError) {
    console.warn('Could not restore the cached account profile.', storageError)
    return null
  }
}

function cacheUser(user: User | null) {
  try {
    if (user) {
      localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user))
    } else {
      localStorage.removeItem(CACHED_USER_KEY)
    }
  } catch (storageError) {
    console.warn('Could not update the cached account profile.', storageError)
  }
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    external: <><path d="M7 17 17 7M7 7h10v10" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    key: <><circle cx="8" cy="15" r="5" /><path d="m11.5 11.5 9-9M17 6l3 3m-6 0 3 3" /></>,
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v12h14V9M9 21v-7h6v7" /></>,
    notes: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8m-8 4h8" /></>,
    pin: <><path d="m16 3 5 5-4 1-4 4 1 4-2 2-3-5-5-3 2-2 4 1 4-4z" /><path d="m9 15-6 6" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16z" /></>,
  }

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

async function authRequest(path: string, body?: object): Promise<AuthResponse> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  })

  if (response.status === 204) return {}

  return readApiResponse<AuthResponse>(response, 'Authentication failed.')
}

async function shortcutsRequest(
  path = '',
  options: { method?: 'POST' | 'DELETE'; body?: object } = {},
): Promise<ShortcutsResponse> {
  const response = await fetch(`/api/shortcuts${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (response.status === 204) return {}
  return readApiResponse<ShortcutsResponse>(response, 'Could not load shortcuts.')
}

async function notesRequest(
  path = '',
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: object } = {},
): Promise<NotesResponse> {
  const response = await fetch(`/api/notes${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (response.status === 204) return {}
  return readApiResponse<NotesResponse>(response, 'Could not manage notes.')
}

async function tasksRequest(
  path = '',
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: object } = {},
): Promise<TasksResponse> {
  const response = await fetch(`/api/tasks${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (response.status === 204) return {}
  return readApiResponse<TasksResponse>(response, 'Could not manage tasks.')
}

async function calendarEventsRequest(
  path = '',
  options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: object } = {},
): Promise<CalendarEventsResponse> {
  const response = await fetch(`/api/calendar/events${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  if (response.status === 204) return {}
  return readApiResponse<CalendarEventsResponse>(response, 'Could not manage calendar events.')
}

async function universityTokenRequest(
  options: { method?: 'GET' | 'PUT' | 'DELETE'; token?: string } = {},
): Promise<UniversityTokenStatus> {
  const method = options.method ?? 'GET'
  const hasBody = method === 'PUT'
  const response = await fetch('/api/integrations/university/token', {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    body: hasBody ? JSON.stringify({ token: options.token ?? '' }) : undefined,
  })

  return readApiResponse<UniversityTokenStatus>(response, 'Could not manage the university token.')
}

function App() {
  const [user, setUser] = useState<User | null>(() => readCachedUser())
  const [activePage, setActivePage] = useState<WorkspacePage>(() => workspacePageFromPath(window.location.pathname))
  const [authChecked, setAuthChecked] = useState(false)
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [shortcutsLoading, setShortcutsLoading] = useState(() => user !== null)
  const [notesLoading, setNotesLoading] = useState(() => user !== null)
  const [tasksLoading, setTasksLoading] = useState(() => user !== null)
  const [calendarLoading, setCalendarLoading] = useState(() => user !== null)
  const [notesError, setNotesError] = useState('')
  const [tasksError, setTasksError] = useState('')
  const [taskDraft, setTaskDraft] = useState('')
  const [taskSaving, setTaskSaving] = useState(false)
  const [calendarError, setCalendarError] = useState('')
  const [calendarEditorOpen, setCalendarEditorOpen] = useState(false)
  const [calendarSaving, setCalendarSaving] = useState(false)
  const [calendarEditorError, setCalendarEditorError] = useState('')
  const [editingCalendarEventId, setEditingCalendarEventId] = useState<string | null>(null)
  const [calendarDraft, setCalendarDraft] = useState<CalendarEventDraft>(() => makeCalendarDraft(localDateString(new Date())))
  const [calendarToday] = useState(() => localDateString(new Date()))
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const today = parseLocalDate(calendarToday)
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(calendarToday)
  const [notificationDropdownOpen, setNotificationDropdownOpen] = useState(false)
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [notePinned, setNotePinned] = useState(false)
  const [noteSaving, setNoteSaving] = useState(false)
  const [noteEditorError, setNoteEditorError] = useState('')
  const [search, setSearch] = useState('')
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [shortcutName, setShortcutName] = useState('')
  const [shortcutUrl, setShortcutUrl] = useState('')
  const [shortcutError, setShortcutError] = useState('')
  const [shortcutSubmitting, setShortcutSubmitting] = useState(false)
  const [universityTokenOpen, setUniversityTokenOpen] = useState(false)
  const [dashboardError, setDashboardError] = useState('')
  const [universityTokenStatus, setUniversityTokenStatus] = useState<UniversityTokenStatus>({
    enabled: false,
    saved: false,
    updated_at: null,
  })
  const [universityToken, setUniversityToken] = useState('')
  const [universityTokenBusy, setUniversityTokenBusy] = useState(false)
  const [universityTokenError, setUniversityTokenError] = useState('')
  const [universityTokenMessage, setUniversityTokenMessage] = useState('')

  useEffect(() => {
    let active = true
    const handlePopState = () => {
      setActivePage(workspacePageFromPath(window.location.pathname))
    }
    window.addEventListener('popstate', handlePopState)

    async function restoreSession() {
      try {
        const { user: currentUser } = await authRequest('me')
        if (!active) return
        setUser(currentUser ?? null)
        cacheUser(currentUser ?? null)
        const destination = currentUser
          ? ['/', '/notes', '/calendar', '/notifications'].includes(window.location.pathname)
            ? window.location.pathname
            : '/'
          : '/login'
        if (window.location.pathname !== destination) {
          window.history.replaceState(null, '', destination)
        }
        setActivePage(workspacePageFromPath(destination))
        if (currentUser) {
          setShortcutsLoading(true)
          try {
            const result = await shortcutsRequest()
            if (active) setShortcuts(result.shortcuts ?? [])
          } catch (requestError) {
            if (active) {
              setDashboardError(requestError instanceof Error ? requestError.message : 'Could not load shortcuts.')
            }
          }
          setNotesLoading(true)
          try {
            const result = await notesRequest()
            if (active) setNotes(result.notes ?? [])
          } catch (requestError) {
            if (active) {
              setNotesError(requestError instanceof Error ? requestError.message : 'Could not load notes.')
            }
          } finally {
            if (active) setNotesLoading(false)
          }
          setTasksLoading(true)
          try {
            const result = await tasksRequest()
            if (active) setTasks(result.tasks ?? [])
          } catch (requestError) {
            if (active) {
              setTasksError(requestError instanceof Error ? requestError.message : 'Could not load tasks.')
            }
          } finally {
            if (active) setTasksLoading(false)
          }
          setCalendarLoading(true)
          try {
            const result = await calendarEventsRequest()
            if (active) setCalendarEvents(result.events ?? [])
          } catch (requestError) {
            if (active) {
              setCalendarError(requestError instanceof Error ? requestError.message : 'Could not load calendar events.')
            }
          } finally {
            if (active) setCalendarLoading(false)
          }
          try {
            const tokenStatus = await universityTokenRequest()
            if (active) setUniversityTokenStatus(tokenStatus)
          } catch (requestError) {
            if (active) {
              setUniversityTokenError(
                requestError instanceof Error ? requestError.message : 'Could not check the university token.',
              )
            }
          }
        }
      } catch (requestError) {
        if (active) {
          const message = requestError instanceof Error
            ? `Could not verify your session: ${requestError.message}`
            : 'Could not verify your session.'
          setUser(null)
          cacheUser(null)
          setMode('login')
          if (window.location.pathname !== '/login') {
            window.history.replaceState(null, '', '/login')
          }
          setError(message)
        }
      } finally {
        if (active) {
          setShortcutsLoading(false)
          setNotesLoading(false)
          setTasksLoading(false)
          setCalendarLoading(false)
          setAuthChecked(true)
        }
      }
    }

    void restoreSession()

    return () => {
      active = false
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const payload = mode === 'register'
        ? { username, email, password }
        : { email, password }
      const result = await authRequest(mode, payload)
      if (!result.user) throw new Error('The server did not return an account.')
      setUser(result.user)
      cacheUser(result.user)
      setDashboardError('')
      setShortcutsLoading(true)
      setNotesLoading(true)
      setTasksLoading(true)
      setCalendarLoading(true)
      try {
        const shortcutResult = await shortcutsRequest()
        setShortcuts(shortcutResult.shortcuts ?? [])
      } catch (requestError) {
        setDashboardError(requestError instanceof Error ? requestError.message : 'Could not load shortcuts.')
      }
      try {
        const noteResult = await notesRequest()
        setNotes(noteResult.notes ?? [])
        setNotesError('')
      } catch (requestError) {
        setNotesError(requestError instanceof Error ? requestError.message : 'Could not load notes.')
      } finally {
        setNotesLoading(false)
      }
      try {
        const taskResult = await tasksRequest()
        setTasks(taskResult.tasks ?? [])
        setTasksError('')
      } catch (requestError) {
        setTasksError(requestError instanceof Error ? requestError.message : 'Could not load tasks.')
      } finally {
        setTasksLoading(false)
      }
      try {
        const calendarResult = await calendarEventsRequest()
        setCalendarEvents(calendarResult.events ?? [])
        setCalendarError('')
      } catch (requestError) {
        setCalendarError(requestError instanceof Error ? requestError.message : 'Could not load calendar events.')
      } finally {
        setCalendarLoading(false)
      }
      try {
        setUniversityTokenStatus(await universityTokenRequest())
        setUniversityTokenError('')
      } catch (requestError) {
        setUniversityTokenError(
          requestError instanceof Error ? requestError.message : 'Could not check the university token.',
        )
      }
      setPassword('')
      if (window.location.pathname !== '/') {
        window.history.replaceState(null, '', '/')
      }
      setActivePage('dashboard')
      setNotificationDropdownOpen(false)
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Authentication failed.'
      setError(message)
    } finally {
      setSubmitting(false)
      setShortcutsLoading(false)
    }
  }

  async function logout() {
    setError('')
    try {
      await authRequest('logout', {})
      setUser(null)
      cacheUser(null)
      setMode('login')
      if (window.location.pathname !== '/login') {
        window.history.replaceState(null, '', '/login')
      }
      setShortcuts([])
      setNotes([])
      setTasks([])
      setCalendarEvents([])
      setTaskDraft('')
      setSearch('')
      setUniversityTokenStatus({ enabled: false, saved: false, updated_at: null })
      setUniversityToken('')
      setUniversityTokenError('')
      setUniversityTokenMessage('')
      setActivePage('dashboard')
      setNotificationDropdownOpen(false)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not log out.')
    }
  }

  async function submitShortcut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setShortcutError('')
    setShortcutSubmitting(true)
    try {
      const result = await shortcutsRequest('', {
        method: 'POST',
        body: { name: shortcutName, url: shortcutUrl },
      })
      const newShortcut = result.shortcut
      if (!newShortcut) throw new Error('The server did not return the shortcut.')
      setShortcuts((current) => [...current, newShortcut])
      setShortcutName('')
      setShortcutUrl('')
      setShortcutOpen(false)
    } catch (requestError) {
      setShortcutError(requestError instanceof Error ? requestError.message : 'Could not add shortcut.')
    } finally {
      setShortcutSubmitting(false)
    }
  }

  async function removeShortcut(id: string) {
    setDashboardError('')
    try {
      await shortcutsRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setShortcuts((current) => current.filter((shortcut) => shortcut.id !== id))
    } catch (requestError) {
      setDashboardError(requestError instanceof Error ? requestError.message : 'Could not remove shortcut.')
    }
  }

  function openNoteEditor(note?: Note) {
    setEditingNoteId(note?.id ?? null)
    setNoteTitle(note?.title ?? '')
    setNoteContent(note?.content ?? '')
    setNotePinned(note?.pinned ?? false)
    setNoteEditorError('')
    setNoteEditorOpen(true)
  }

  async function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setNoteSaving(true)
    setNoteEditorError('')
    try {
      const body = { title: noteTitle, content: noteContent, pinned: notePinned }
      const result = await notesRequest(
        editingNoteId ? `/${encodeURIComponent(editingNoteId)}` : '',
        { method: editingNoteId ? 'PUT' : 'POST', body },
      )
      const savedNote = result.note
      if (!savedNote) throw new Error('The server did not return the saved note.')
      setNotes((current) => [
        savedNote,
        ...current.filter((note) => note.id !== savedNote.id),
      ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at))
      setNoteEditorOpen(false)
    } catch (requestError) {
      setNoteEditorError(requestError instanceof Error ? requestError.message : 'Could not save the note.')
    } finally {
      setNoteSaving(false)
    }
  }

  async function toggleNotePin(note: Note) {
    setNotesError('')
    try {
      const result = await notesRequest(`/${encodeURIComponent(note.id)}`, {
        method: 'PUT',
        body: { title: note.title, content: note.content, pinned: !note.pinned },
      })
      const updatedNote = result.note
      if (!updatedNote) throw new Error('The server did not return the updated note.')
      setNotes((current) => [
        updatedNote,
        ...current.filter((currentNote) => currentNote.id !== note.id),
      ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at))
    } catch (requestError) {
      setNotesError(requestError instanceof Error ? requestError.message : 'Could not update note pin.')
    }
  }

  async function removeNote(note: Note) {
    setNotesError('')
    try {
      await notesRequest(`/${encodeURIComponent(note.id)}`, { method: 'DELETE' })
      setNotes((current) => current.filter((currentNote) => currentNote.id !== note.id))
    } catch (requestError) {
      setNotesError(requestError instanceof Error ? requestError.message : 'Could not remove the note.')
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTaskSaving(true)
    setTasksError('')
    try {
      const result = await tasksRequest('', {
        method: 'POST',
        body: { text: taskDraft },
      })
      const newTask = result.task
      if (!newTask) throw new Error('The server did not return the saved task.')
      setTasks((current) => [newTask, ...current])
      setTaskDraft('')
    } catch (requestError) {
      setTasksError(requestError instanceof Error ? requestError.message : 'Could not add task.')
    } finally {
      setTaskSaving(false)
    }
  }

  async function toggleTask(task: Task) {
    setTasksError('')
    try {
      const result = await tasksRequest(`/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: { completed: !task.completed },
      })
      const updatedTask = result.task
      if (!updatedTask) throw new Error('The server did not return the updated task.')
      setTasks((current) =>
        current
          .map((currentTask) => currentTask.id === task.id ? updatedTask : currentTask)
          .sort((a, b) => Number(a.completed) - Number(b.completed) || b.created_at - a.created_at),
      )
    } catch (requestError) {
      setTasksError(requestError instanceof Error ? requestError.message : 'Could not update task.')
    }
  }

  async function removeTask(task: Task) {
    setTasksError('')
    try {
      await tasksRequest(`/${encodeURIComponent(task.id)}`, { method: 'DELETE' })
      setTasks((current) => current.filter((currentTask) => currentTask.id !== task.id))
    } catch (requestError) {
      setTasksError(requestError instanceof Error ? requestError.message : 'Could not remove task.')
    }
  }

  function navigateTo(page: WorkspacePage) {
    const path = page === 'dashboard'
      ? '/'
      : page === 'notes' ? '/notes' : page === 'calendar' ? '/calendar' : '/notifications'
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path)
    }
    setActivePage(page)
    setNotificationDropdownOpen(false)
  }

  function openCalendarEditor(event?: CalendarEvent, date = selectedCalendarDate) {
    setEditingCalendarEventId(event?.id ?? null)
    setCalendarDraft(event ? {
      title: event.title,
      description: event.description,
      color: event.color,
      event_type: event.event_type,
      schedule: event.schedule,
      event_date: event.event_date,
      start_date: event.start_date,
      end_date: event.end_date,
      weekdays: [...event.weekdays],
      start_time: event.start_time,
      end_time: event.end_time,
      reminder_days: event.reminder_days,
    } : makeCalendarDraft(date))
    setCalendarEditorError('')
    setCalendarEditorOpen(true)
  }

  async function submitCalendarEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCalendarSaving(true)
    setCalendarEditorError('')
    try {
      const result = await calendarEventsRequest(
        editingCalendarEventId ? `/${encodeURIComponent(editingCalendarEventId)}` : '',
        { method: editingCalendarEventId ? 'PUT' : 'POST', body: calendarDraft },
      )
      const savedEvent = result.event
      if (!savedEvent) throw new Error('The server did not return the saved calendar item.')
      setCalendarEvents((current) => [
        savedEvent,
        ...current.filter((currentEvent) => currentEvent.id !== savedEvent.id),
      ])
      setCalendarEditorOpen(false)
    } catch (requestError) {
      setCalendarEditorError(requestError instanceof Error ? requestError.message : 'Could not save calendar item.')
    } finally {
      setCalendarSaving(false)
    }
  }

  async function removeCalendarEvent(event: CalendarEvent) {
    setCalendarError('')
    try {
      await calendarEventsRequest(`/${encodeURIComponent(event.id)}`, { method: 'DELETE' })
      setCalendarEvents((current) => current.filter((currentEvent) => currentEvent.id !== event.id))
    } catch (requestError) {
      setCalendarError(requestError instanceof Error ? requestError.message : 'Could not delete calendar item.')
    }
  }

  function changeCalendarMonth(amount: number) {
    setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1))
  }

  async function saveUniversityToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setUniversityTokenBusy(true)
    setUniversityTokenError('')
    setUniversityTokenMessage('')
    try {
      const status = await universityTokenRequest({
        method: 'PUT',
        token: universityToken.trim(),
      })
      setUniversityTokenStatus(status)
      setUniversityToken('')
      setUniversityTokenMessage('Token saved securely.')
    } catch (requestError) {
      setUniversityTokenError(
        requestError instanceof Error ? requestError.message : 'Could not save the university token.',
      )
    } finally {
      setUniversityTokenBusy(false)
    }
  }

  async function deleteUniversityToken() {
    setUniversityTokenBusy(true)
    setUniversityTokenError('')
    setUniversityTokenMessage('')
    try {
      const status = await universityTokenRequest({ method: 'DELETE' })
      setUniversityTokenStatus(status)
      setUniversityToken('')
      setUniversityTokenMessage('Saved token removed.')
    } catch (requestError) {
      setUniversityTokenError(
        requestError instanceof Error ? requestError.message : 'Could not remove the university token.',
      )
    } finally {
      setUniversityTokenBusy(false)
    }
  }

  const filteredShortcuts = shortcuts.filter((shortcut) =>
    `${shortcut.name} ${shortcut.url}`.toLowerCase().includes(search.toLowerCase()),
  )
  const calendarReminders = getCalendarReminders(calendarEvents, calendarToday)
  const calendarDates = getCalendarMonthDates(calendarMonth)
  const selectedDateEvents = calendarEvents.filter((event) => eventOccursOnDate(event, selectedCalendarDate))
  if (!authChecked) {
    return (
      <main className="auth-page" role="status">
        <p>Checking your session…</p>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section aria-labelledby="auth-title" className="auth-dialog">
          <div className="auth-brand-mark"><span /></div>
          <p className="auth-eyebrow">YOUR STUDYSPACE</p>
          <h1 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="auth-subtitle">
            {mode === 'login' ? 'Log in to continue to your workspace.' : 'Set up an account for your workspace.'}
          </p>
          <form className="auth-form" onSubmit={submitAuth}>
            {mode === 'register' && (
              <label>
                Username
                <input
                  autoComplete="username"
                  maxLength={32}
                  minLength={2}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  value={username}
                />
              </label>
            )}
            <label>
              Email
              <input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label>
              Password
              <input
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'register' ? 8 : undefined}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" disabled={submitting} type="submit">
              {submitting ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>
          <p className="auth-switch">
            {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
            <button
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
              }}
              type="button"
            >
              {mode === 'login' ? 'Create an account' : 'Log in'}
            </button>
          </p>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main menu">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark"><Icon name="notes" size={18} /></span>
          <span>Studyspace</span>
        </div>
        <nav className="sidebar-nav" aria-label="Workspace">
          <button
            aria-current={activePage === 'dashboard' ? 'page' : undefined}
            className={`sidebar-nav-item ${activePage === 'dashboard' ? 'sidebar-nav-item-active' : ''}`}
            onClick={() => navigateTo('dashboard')}
            type="button"
          >
            <Icon name="home" size={17} />
            <span>Dashboard</span>
          </button>
          <button
            aria-current={activePage === 'notes' ? 'page' : undefined}
            className={`sidebar-nav-item ${activePage === 'notes' ? 'sidebar-nav-item-active' : ''}`}
            onClick={() => navigateTo('notes')}
            type="button"
          >
            <Icon name="notes" size={17} />
            <span>Notes</span>
            {notes.length > 0 && <span className="sidebar-nav-count">{notes.length}</span>}
          </button>
          <button
            aria-current={activePage === 'calendar' ? 'page' : undefined}
            className={`sidebar-nav-item ${activePage === 'calendar' ? 'sidebar-nav-item-active' : ''}`}
            onClick={() => navigateTo('calendar')}
            type="button"
          >
            <Icon name="calendar" size={17} />
            <span>Calendar</span>
          </button>
        </nav>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span><Icon name="chevron" size={15} />
            <strong>
              {activePage === 'notes' ? 'Notes'
                : activePage === 'calendar' ? 'Calendar'
                  : activePage === 'notifications' ? 'Notifications' : 'Overview'}
            </strong>
          </div>
          <div className="topbar-actions">
            {activePage === 'dashboard' && (
              <label className="search-box">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  placeholder="Search your shortcuts..."
                  aria-label="Search your shortcuts"
                  onChange={(event) => setSearch(event.target.value)}
                  value={search}
                />
                <kbd>/</kbd>
              </label>
            )}
            <div className="notification-menu-wrap">
              <button
                aria-expanded={notificationDropdownOpen}
                aria-label={`Notifications${calendarReminders.length ? ` (${calendarReminders.length})` : ''}`}
                className="icon-button notification-button"
                onClick={() => setNotificationDropdownOpen((open) => !open)}
                type="button"
              >
                <Icon name="bell" size={19} />
                {calendarReminders.length > 0 && <span>{calendarReminders.length > 9 ? '9+' : calendarReminders.length}</span>}
              </button>
              {notificationDropdownOpen && (
                <div className="notification-dropdown">
                  <div className="notification-dropdown-heading">
                    <strong>Upcoming reminders</strong>
                    <span>{calendarReminders.length}</span>
                  </div>
                  {calendarReminders.length === 0 ? (
                    <p className="notification-empty">No upcoming reminders. Set reminders on calendar items to see them here.</p>
                  ) : (
                    <ul>
                      {calendarReminders.slice(0, 5).map((reminder) => (
                        <li key={`${reminder.event.id}-${reminder.occurrenceDate}`}>
                          <span className="notification-color" style={{ backgroundColor: reminder.event.color }} />
                          <button
                            className="notification-item"
                            onClick={() => {
                              setSelectedCalendarDate(reminder.occurrenceDate)
                              setCalendarMonth(() => {
                                const date = parseLocalDate(reminder.occurrenceDate)
                                return new Date(date.getFullYear(), date.getMonth(), 1)
                              })
                              navigateTo('calendar')
                            }}
                            type="button"
                          >
                            <strong>{reminder.event.title}</strong>
                            <span>{formatReminderDate(reminder.reminderDate, calendarToday)} · {formatCalendarDate(reminder.occurrenceDate, { month: 'short', day: 'numeric' })}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="notification-see-all" onClick={() => navigateTo('notifications')} type="button">
                    See all reminders
                  </button>
                </div>
              )}
            </div>
            <div className="account-actions">
              <div className="account-avatar" aria-label={`Signed in as ${user.username}`}>
                {user.username.slice(0, 1).toUpperCase()}
              </div>
              <span className="account-name">{user.username}</span>
              <button
                aria-label="University token settings"
                className="account-tool-button"
                onClick={() => setUniversityTokenOpen(true)}
                title="University token settings"
                type="button"
              >
                <Icon name="key" size={16} />
              </button>
              <button className="logout-button" onClick={logout} type="button">Log out</button>
            </div>
          </div>
        </header>
        {error && <p className="global-error" role="alert">{error}</p>}
        {activePage === 'dashboard' ? (
          <section className="dashboard">
            <div className="dashboard-heading">
              <div>
                <p className="dashboard-eyebrow">YOUR STUDYSPACE</p>
                <h1>Your shortcuts</h1>
                <p className="dashboard-description">Your important websites, together in one place.</p>
              </div>
              <button
                className="add-shortcut-button"
                onClick={() => {
                  setShortcutError('')
                  setShortcutOpen(true)
                }}
                type="button"
              >
                <Icon name="plus" size={17} /> Add shortcut
              </button>
            </div>
            {dashboardError && <p className="global-error" role="alert">{dashboardError}</p>}
            {shortcutsLoading ? (
              <div className="shortcuts-message">Loading your shortcuts…</div>
            ) : shortcuts.length === 0 ? (
              <div className="empty-shortcuts">
                <span className="empty-shortcuts-icon"><Icon name="external" size={22} /></span>
                <h2>Make this space yours</h2>
                <p>Add the websites you use for studying. They’ll be ready here whenever you need them.</p>
                <button className="add-shortcut-button" onClick={() => setShortcutOpen(true)} type="button">
                  <Icon name="plus" size={17} /> Add your first shortcut
                </button>
              </div>
            ) : filteredShortcuts.length === 0 ? (
              <div className="shortcuts-message">No shortcuts match “{search}”.</div>
            ) : (
              <div className="shortcut-grid">
                {filteredShortcuts.map((shortcut) => (
                  <article className="shortcut-card" key={shortcut.id}>
                    <a className="shortcut-link" href={shortcut.url} rel="noreferrer" target="_blank">
                      <span className="shortcut-icon">
                        <Icon name="globe" size={23} />
                        {shortcut.icon_data && <img alt="" src={shortcut.icon_data} />}
                      </span>
                      <span className="shortcut-copy">
                        <strong>{shortcut.name}</strong>
                        <span>{new URL(shortcut.url).hostname}</span>
                      </span>
                      <Icon name="external" size={16} />
                    </a>
                    <button
                      aria-label={`Remove ${shortcut.name}`}
                      className="remove-shortcut-button"
                      onClick={() => void removeShortcut(shortcut.id)}
                      title="Remove shortcut"
                      type="button"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </article>
                ))}
              </div>
            )}
            {tasksError && <p className="global-error" role="alert">{tasksError}</p>}
            <section className="task-list-section" aria-labelledby="task-list-title">
              <div className="section-heading">
                <div>
                  <p className="dashboard-eyebrow">STAY ON TRACK</p>
                  <h2 id="task-list-title">To-do list</h2>
                </div>
                {!tasksLoading && tasks.length > 0 && (
                  <span className="task-progress">
                    {tasks.filter((task) => task.completed).length}/{tasks.length} done
                  </span>
                )}
              </div>
              <form className="task-add-form" onSubmit={submitTask}>
                <input
                  aria-label="New task"
                  maxLength={300}
                  onChange={(event) => setTaskDraft(event.target.value)}
                  placeholder="Add a task…"
                  required
                  value={taskDraft}
                />
                <button aria-label="Add task" className="task-add-button" disabled={taskSaving || !taskDraft.trim()} type="submit">
                  <Icon name="plus" size={17} />
                </button>
              </form>
              {tasksLoading ? (
                <div className="shortcuts-message">Loading your tasks…</div>
              ) : tasks.length === 0 ? (
                <p className="task-list-empty">Your tasks will appear here. Add one to get started.</p>
              ) : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li className={`task-row ${task.completed ? 'task-row-completed' : ''}`} key={task.id}>
                      <label className="task-check-label">
                        <input
                          checked={task.completed}
                          onChange={() => void toggleTask(task)}
                          type="checkbox"
                        />
                        <span className="task-checkmark"><Icon name="check" size={13} /></span>
                        <span className="task-text">{task.text}</span>
                      </label>
                      <button
                        aria-label={`Remove task: ${task.text}`}
                        className="task-remove-button"
                        onClick={() => void removeTask(task)}
                        title="Remove task"
                        type="button"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {notesError && <p className="global-error" role="alert">{notesError}</p>}
            <section className="pinned-notes-section" aria-labelledby="pinned-notes-title">
              <div className="section-heading">
                <div>
                  <p className="dashboard-eyebrow">QUICK ACCESS</p>
                  <h2 id="pinned-notes-title">Pinned notes</h2>
                </div>
                <button className="text-action" onClick={() => navigateTo('notes')} type="button">
                  All notes <Icon name="chevron" size={15} />
                </button>
              </div>
              {notesLoading ? (
                <div className="shortcuts-message">Loading your notes…</div>
              ) : notes.filter((note) => note.pinned).length === 0 ? (
                <p className="pinned-notes-empty">Pin notes to keep them close on your dashboard.</p>
              ) : (
                <div className="notes-grid pinned-notes-grid">
                  {notes.filter((note) => note.pinned).map((note) => (
                    <article className="note-card pinned-note-card" key={note.id}>
                      <button
                        className="note-card-open"
                        onClick={() => {
                          navigateTo('notes')
                          openNoteEditor(note)
                        }}
                        type="button"
                      >
                        <strong>{note.title}</strong>
                        <span>{note.content.trim() || 'No note content'}</span>
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : activePage === 'notes' ? (
          <section className="dashboard notes-page">
            <div className="dashboard-heading">
              <div>
                <p className="dashboard-eyebrow">YOUR STUDYSPACE</p>
                <h1>Notes</h1>
                <p className="dashboard-description">Keep study notes organized and pin the important ones to your dashboard.</p>
              </div>
              <button className="add-shortcut-button" onClick={() => openNoteEditor()} type="button">
                <Icon name="plus" size={17} /> New note
              </button>
            </div>
            {notesError && <p className="global-error" role="alert">{notesError}</p>}
            {notesLoading ? (
              <div className="shortcuts-message">Loading your notes…</div>
            ) : notes.length === 0 ? (
              <div className="empty-shortcuts">
                <span className="empty-shortcuts-icon"><Icon name="notes" size={22} /></span>
                <h2>Start your notes collection</h2>
                <p>Create notes for lectures, revision, or anything you want to keep organized.</p>
                <button className="add-shortcut-button" onClick={() => openNoteEditor()} type="button">
                  <Icon name="plus" size={17} /> Create your first note
                </button>
              </div>
            ) : (
              <div className="notes-grid">
                {notes.map((note) => (
                  <article className="note-card" key={note.id}>
                    <div className="note-card-heading">
                      <button className="note-card-open" onClick={() => openNoteEditor(note)} type="button">
                        <strong>{note.title}</strong>
                        <span>{note.content.trim() || 'No note content'}</span>
                      </button>
                      <button
                        aria-label={note.pinned ? `Unpin ${note.title}` : `Pin ${note.title}`}
                        aria-pressed={note.pinned}
                        className={`note-icon-button ${note.pinned ? 'note-icon-button-pinned' : ''}`}
                        onClick={() => void toggleNotePin(note)}
                        title={note.pinned ? 'Unpin note from dashboard' : 'Pin note to dashboard'}
                        type="button"
                      >
                        <Icon name="pin" size={16} />
                      </button>
                    </div>
                    <div className="note-card-footer">
                      <span>{new Date(note.updated_at * 1000).toLocaleDateString()}</span>
                      <button className="note-delete-button" onClick={() => void removeNote(note)} type="button">
                        <Icon name="trash" size={14} /> Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : activePage === 'calendar' ? (
          <section className="dashboard calendar-page">
            <div className="dashboard-heading">
              <div>
                <p className="dashboard-eyebrow">PLAN YOUR STUDY</p>
                <h1>Calendar</h1>
                <p className="dashboard-description">Keep tests, events, and weekly classes in one place.</p>
              </div>
              <button className="add-shortcut-button" onClick={() => openCalendarEditor()} type="button">
                <Icon name="plus" size={17} /> Add event or class
              </button>
            </div>
            {calendarError && <p className="global-error" role="alert">{calendarError}</p>}
            {calendarLoading ? (
              <div className="shortcuts-message">Loading your calendar…</div>
            ) : (
              <>
                <section className="calendar-month" aria-label="Monthly calendar">
                  <div className="calendar-month-heading">
                    <div>
                      <p className="dashboard-eyebrow">MONTH VIEW</p>
                      <h2>{calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
                    </div>
                    <div className="calendar-month-actions">
                      <button className="calendar-nav-button" aria-label="Previous month" onClick={() => changeCalendarMonth(-1)} type="button">‹</button>
                      <button
                        className="calendar-today-button"
                        onClick={() => {
                          const today = localDateString(new Date())
                          setSelectedCalendarDate(today)
                          setCalendarMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
                        }}
                        type="button"
                      >
                        Today
                      </button>
                      <button className="calendar-nav-button" aria-label="Next month" onClick={() => changeCalendarMonth(1)} type="button">›</button>
                    </div>
                  </div>
                  <div className="calendar-weekdays" aria-hidden="true">
                    {WEEKDAYS.map((day) => <span key={day.value}>{day.short}</span>)}
                  </div>
                  <div className="calendar-month-grid">
                    {calendarDates.map((date) => {
                      const dayEvents = calendarEvents.filter((event) => eventOccursOnDate(event, date))
                      const inMonth = parseLocalDate(date).getMonth() === calendarMonth.getMonth()
                      return (
                        <div
                          className={`calendar-day-cell ${inMonth ? '' : 'calendar-day-outside'} ${date === selectedCalendarDate ? 'calendar-day-selected' : ''} ${date === calendarToday ? 'calendar-day-today' : ''}`}
                          key={date}
                        >
                          <button
                            aria-label={formatCalendarDate(date)}
                            aria-pressed={date === selectedCalendarDate}
                            className="calendar-day-number"
                            onClick={() => setSelectedCalendarDate(date)}
                            type="button"
                          >
                            {parseLocalDate(date).getDate()}
                          </button>
                          <div className="calendar-day-items">
                            {dayEvents.slice(0, 3).map((calendarEvent) => (
                              <button
                                className="calendar-day-event"
                                key={calendarEvent.id}
                                onClick={() => {
                                  setSelectedCalendarDate(date)
                                  openCalendarEditor(calendarEvent, date)
                                }}
                                style={{ '--event-color': calendarEvent.color } as React.CSSProperties}
                                title={calendarEvent.title}
                                type="button"
                              >
                                <span />
                                {calendarEvent.title}
                              </button>
                            ))}
                            {dayEvents.length > 3 && <span className="calendar-day-more">+{dayEvents.length - 3} more</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>

                <section className="calendar-selected-day" aria-labelledby="selected-day-heading">
                  <div className="section-heading">
                    <div>
                      <p className="dashboard-eyebrow">SCHEDULE</p>
                      <h2 id="selected-day-heading">{formatCalendarDate(selectedCalendarDate, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
                    </div>
                    <button className="text-action" onClick={() => openCalendarEditor(undefined, selectedCalendarDate)} type="button">
                      <Icon name="plus" size={15} /> Add to this day
                    </button>
                  </div>
                  {selectedDateEvents.length === 0 ? (
                    <p className="calendar-no-events">Nothing scheduled for this day.</p>
                  ) : (
                    <div className="calendar-event-list">
                      {selectedDateEvents.map((calendarEvent) => (
                        <article className="calendar-event-row" key={calendarEvent.id}>
                          <span className="calendar-event-accent" style={{ backgroundColor: calendarEvent.color }} />
                          <div className="calendar-event-content">
                            <div className="calendar-event-title-line">
                              <span className="calendar-event-kind">{calendarEvent.event_type === 'class' ? 'Weekly class' : 'Event'}</span>
                              <strong>{calendarEvent.title}</strong>
                            </div>
                            {(calendarEvent.start_time || calendarEvent.description) && (
                              <p className="calendar-event-meta">
                                {calendarEvent.start_time && (
                                  <span><Icon name="clock" size={13} /> {calendarEvent.start_time}–{calendarEvent.end_time}</span>
                                )}
                                {calendarEvent.description && <span>{calendarEvent.description}</span>}
                              </p>
                            )}
                          </div>
                          {calendarEvent.reminder_days > 0 && (
                            <span className="calendar-reminder-tag">{calendarEvent.reminder_days}d reminder</span>
                          )}
                          <button aria-label={`Edit ${calendarEvent.title}`} className="calendar-item-button" onClick={() => openCalendarEditor(calendarEvent, selectedCalendarDate)} type="button">
                            <Icon name="edit" size={15} />
                          </button>
                          <button aria-label={`Delete ${calendarEvent.title}`} className="calendar-item-button calendar-item-delete" onClick={() => void removeCalendarEvent(calendarEvent)} type="button">
                            <Icon name="trash" size={15} />
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </section>
        ) : (
          <section className="dashboard notifications-page">
            <div className="dashboard-heading">
              <div>
                <p className="dashboard-eyebrow">YOUR STUDYSPACE</p>
                <h1>Notifications</h1>
                <p className="dashboard-description">Upcoming reminders from your calendar. These appear in the bell menu.</p>
              </div>
              <button className="text-action" onClick={() => navigateTo('calendar')} type="button">
                Open calendar <Icon name="chevron" size={15} />
              </button>
            </div>
            {calendarError && <p className="global-error" role="alert">{calendarError}</p>}
            {calendarLoading ? (
              <div className="shortcuts-message">Loading reminders…</div>
            ) : calendarReminders.length === 0 ? (
              <div className="empty-shortcuts">
                <span className="empty-shortcuts-icon"><Icon name="bell" size={22} /></span>
                <h2>No upcoming reminders</h2>
                <p>Add a reminder to an event or weekly class and it will appear here on the days before it occurs.</p>
                <button className="add-shortcut-button" onClick={() => navigateTo('calendar')} type="button">
                  <Icon name="calendar" size={16} /> Go to calendar
                </button>
              </div>
            ) : (
              <div className="notification-list">
                {calendarReminders.map((reminder) => (
                  <button
                    className="notification-card"
                    key={`${reminder.event.id}-${reminder.occurrenceDate}`}
                    onClick={() => {
                      setSelectedCalendarDate(reminder.occurrenceDate)
                      const date = parseLocalDate(reminder.occurrenceDate)
                      setCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1))
                      navigateTo('calendar')
                    }}
                    type="button"
                  >
                    <span className="notification-card-color" style={{ backgroundColor: reminder.event.color }} />
                    <span className="notification-card-copy">
                      <strong>{reminder.event.title}</strong>
                      <span>{reminder.event.event_type === 'class' ? 'Weekly class' : 'Event'} · {reminder.event.description || 'No description'}</span>
                    </span>
                    <span className="notification-card-dates">
                      <strong>{formatReminderDate(reminder.reminderDate, calendarToday)}</strong>
                      <span>For {formatCalendarDate(reminder.occurrenceDate, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {calendarEditorOpen && (
        <div
          className="auth-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCalendarEditorOpen(false)
          }}
        >
          <section aria-labelledby="calendar-editor-title" aria-modal="true" className="auth-dialog calendar-editor-dialog" role="dialog">
            <button aria-label="Close" className="auth-close" onClick={() => setCalendarEditorOpen(false)} type="button">×</button>
            <span className="university-icon"><Icon name="calendar" size={19} /></span>
            <p className="auth-eyebrow">YOUR STUDYSPACE</p>
            <h1 id="calendar-editor-title">{editingCalendarEventId ? 'Edit calendar item' : 'Add to calendar'}</h1>
            <p className="auth-subtitle">Create a one-day event or a weekly class that repeats in a date range.</p>
            <form className="auth-form calendar-editor-form" onSubmit={submitCalendarEvent}>
              <label>
                Type
                <select
                  onChange={(event) => {
                    const eventType = event.target.value as CalendarEvent['event_type']
                    setCalendarDraft((current) => eventType === 'class'
                      ? {
                        ...current,
                        event_type: 'class',
                        schedule: 'weekly',
                        event_date: null,
                        start_date: selectedCalendarDate,
                        end_date: shiftDate(selectedCalendarDate, 90),
                        weekdays: [parseLocalDate(selectedCalendarDate).getDay() || 7],
                      }
                      : {
                        ...current,
                        event_type: 'event',
                        schedule: 'once',
                        event_date: selectedCalendarDate,
                        start_date: null,
                        end_date: null,
                        weekdays: [],
                      })
                  }}
                  value={calendarDraft.event_type}
                >
                  <option value="event">One-day event (test, deadline, etc.)</option>
                  <option value="class">Weekly class</option>
                </select>
              </label>
              <label>
                Title
                <input
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setCalendarDraft((current) => ({ ...current, title: event.target.value }))}
                  required
                  value={calendarDraft.title}
                />
              </label>
              <label>
                Description
                <textarea
                  maxLength={4000}
                  onChange={(event) => setCalendarDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Add useful details…"
                  value={calendarDraft.description}
                />
              </label>
              {calendarDraft.event_type === 'event' ? (
                <label>
                  Date
                  <input
                    onChange={(event) => {
                      setSelectedCalendarDate(event.target.value)
                      const date = parseLocalDate(event.target.value)
                      setCalendarMonth(new Date(date.getFullYear(), date.getMonth(), 1))
                      setCalendarDraft((current) => ({ ...current, event_date: event.target.value }))
                    }}
                    required
                    type="date"
                    value={calendarDraft.event_date ?? ''}
                  />
                </label>
              ) : (
                <>
                  <div className="calendar-date-range">
                    <label>
                      Starts
                      <input
                        onChange={(event) => setCalendarDraft((current) => ({ ...current, start_date: event.target.value }))}
                        required
                        type="date"
                        value={calendarDraft.start_date ?? ''}
                      />
                    </label>
                    <label>
                      Ends
                      <input
                        onChange={(event) => setCalendarDraft((current) => ({ ...current, end_date: event.target.value }))}
                        required
                        type="date"
                        value={calendarDraft.end_date ?? ''}
                      />
                    </label>
                  </div>
                  <fieldset className="calendar-weekday-picker">
                    <legend>Repeats on</legend>
                    <div>
                      {WEEKDAYS.map((day) => (
                        <label key={day.value} title={day.label}>
                          <input
                            checked={calendarDraft.weekdays.includes(day.value)}
                            onChange={(event) => setCalendarDraft((current) => ({
                              ...current,
                              weekdays: event.target.checked
                                ? [...current.weekdays, day.value].sort((a, b) => a - b)
                                : current.weekdays.filter((weekday) => weekday !== day.value),
                            }))}
                            type="checkbox"
                          />
                          <span>{day.short}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              <div className="calendar-date-range">
                <label>
                  Starts at <span className="optional-label">optional</span>
                  <input
                    onChange={(event) => setCalendarDraft((current) => ({ ...current, start_time: event.target.value || null }))}
                    type="time"
                    value={calendarDraft.start_time ?? ''}
                  />
                </label>
                <label>
                  Ends at <span className="optional-label">optional</span>
                  <input
                    onChange={(event) => setCalendarDraft((current) => ({ ...current, end_time: event.target.value || null }))}
                    type="time"
                    value={calendarDraft.end_time ?? ''}
                  />
                </label>
              </div>
              <label>
                Remind me
                <select
                  onChange={(event) => setCalendarDraft((current) => ({ ...current, reminder_days: Number(event.target.value) }))}
                  value={calendarDraft.reminder_days}
                >
                  <option value={0}>No reminder</option>
                  {Array.from({ length: 30 }, (_, index) => index + 1).map((days) => (
                    <option key={days} value={days}>{days} {days === 1 ? 'day' : 'days'} before</option>
                  ))}
                </select>
              </label>
              <fieldset className="calendar-color-picker">
                <legend>Color</legend>
                <div>
                  {CALENDAR_COLORS.map((color) => (
                    <label key={color.value} title={color.label}>
                      <input
                        checked={calendarDraft.color === color.value}
                        name="calendar-color"
                        onChange={() => setCalendarDraft((current) => ({ ...current, color: color.value }))}
                        type="radio"
                        value={color.value}
                      />
                      <span style={{ backgroundColor: color.value }} />
                    </label>
                  ))}
                </div>
              </fieldset>
              {calendarEditorError && <p className="auth-error" role="alert">{calendarEditorError}</p>}
              <p className="calendar-reminder-help">Reminders are shown in the bell menu and on the notifications page.</p>
              <button className="auth-submit" disabled={calendarSaving} type="submit">
                {calendarSaving ? 'Saving…' : editingCalendarEventId ? 'Save changes' : 'Add to calendar'}
              </button>
            </form>
          </section>
        </div>
      )}

      {noteEditorOpen && (
        <div
          className="auth-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNoteEditorOpen(false)
          }}
        >
          <section aria-labelledby="note-editor-title" aria-modal="true" className="auth-dialog note-editor-dialog" role="dialog">
            <button aria-label="Close" className="auth-close" onClick={() => setNoteEditorOpen(false)} type="button">×</button>
            <span className="university-icon"><Icon name="notes" size={19} /></span>
            <p className="auth-eyebrow">YOUR STUDYSPACE</p>
            <h1 id="note-editor-title">{editingNoteId ? 'Edit note' : 'New note'}</h1>
            <p className="auth-subtitle">Notes are saved to your account and available when you sign in.</p>
            <form className="auth-form note-editor-form" onSubmit={submitNote}>
              <label>
                Title
                <input
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setNoteTitle(event.target.value)}
                  required
                  value={noteTitle}
                />
              </label>
              <label>
                Note
                <textarea
                  maxLength={50000}
                  onChange={(event) => setNoteContent(event.target.value)}
                  placeholder="Write your study notes…"
                  value={noteContent}
                />
              </label>
              <label className="note-pin-option">
                <input checked={notePinned} onChange={(event) => setNotePinned(event.target.checked)} type="checkbox" />
                Pin this note to the dashboard
              </label>
              {noteEditorError && <p className="auth-error" role="alert">{noteEditorError}</p>}
              <button className="auth-submit" disabled={noteSaving} type="submit">
                {noteSaving ? 'Saving…' : editingNoteId ? 'Save changes' : 'Create note'}
              </button>
            </form>
          </section>
        </div>
      )}

      {universityTokenOpen && user && (
        <div
          className="auth-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setUniversityTokenOpen(false)
          }}
        >
          <section aria-labelledby="university-token-title" aria-modal="true" className="auth-dialog university-token-dialog" role="dialog">
            <button
              aria-label="Close"
              className="auth-close"
              onClick={() => setUniversityTokenOpen(false)}
              type="button"
            >
              ×
            </button>
            <span className="university-icon"><Icon name="key" size={19} /></span>
            <p className="auth-eyebrow">ACCOUNT INTEGRATION</p>
            <h1 id="university-token-title">University website token</h1>
            <p className="auth-subtitle">Paste the token copied from your university website to keep it with your account.</p>
            <span className={`token-status ${universityTokenStatus.saved ? 'token-status-saved' : ''}`}>
              <span />
              {universityTokenStatus.saved ? 'Token saved' : universityTokenStatus.enabled ? 'Not connected' : 'Setup needed'}
            </span>
            {universityTokenStatus.enabled ? (
              <form className="university-token-form" onSubmit={saveUniversityToken}>
                <label htmlFor="university-jwt">University token</label>
                <textarea
                  autoComplete="off"
                  id="university-jwt"
                  maxLength={16384}
                  onChange={(event) => setUniversityToken(event.target.value)}
                  placeholder={universityTokenStatus.saved ? 'Paste a new token to replace the saved one' : 'Paste university token here'}
                  required
                  spellCheck={false}
                  value={universityToken}
                />
                <div className="university-token-actions">
                  <p>Encrypted before storage. A saved token cannot be viewed here.</p>
                  <div>
                    {universityTokenStatus.saved && (
                      <button
                        className="remove-token-button"
                        disabled={universityTokenBusy}
                        onClick={() => void deleteUniversityToken()}
                        type="button"
                      >
                        Remove token
                      </button>
                    )}
                    <button
                      className="add-shortcut-button"
                      disabled={universityTokenBusy || !universityToken.trim()}
                      type="submit"
                    >
                      {universityTokenBusy ? 'Saving…' : universityTokenStatus.saved ? 'Replace token' : 'Save token'}
                    </button>
                  </div>
                </div>
                {universityTokenMessage && <p className="token-message" role="status">{universityTokenMessage}</p>}
                {universityTokenError && <p className="auth-error" role="alert">{universityTokenError}</p>}
              </form>
            ) : universityTokenStatus.saved ? (
              <div className="token-setup-note">
                <p>The saved token is encrypted, but the backend encryption key is unavailable. Configure the original JWT_ENCRYPTION_KEY to use it again.</p>
                {universityTokenError && <p className="auth-error" role="alert">{universityTokenError}</p>}
                <div className="token-disabled-actions">
                  {universityTokenMessage && <p className="token-message" role="status">{universityTokenMessage}</p>}
                  <button
                    className="remove-token-button"
                    disabled={universityTokenBusy}
                    onClick={() => void deleteUniversityToken()}
                    type="button"
                  >
                    Remove saved token
                  </button>
                </div>
              </div>
            ) : (
              <p className="token-setup-note">
                {universityTokenError || 'Token storage is disabled. Add JWT_ENCRYPTION_KEY to the project root .env file and restart the backend. See the README for setup.'}
              </p>
            )}
          </section>
        </div>
      )}

      {shortcutOpen && (
        <div
          className="auth-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShortcutOpen(false)
          }}
        >
          <section aria-labelledby="shortcut-title" aria-modal="true" className="auth-dialog" role="dialog">
            <button
              aria-label="Close"
              className="auth-close"
              onClick={() => setShortcutOpen(false)}
              type="button"
            >
              ×
            </button>
            <div className="auth-brand-mark"><span /></div>
            <p className="auth-eyebrow">YOUR STUDYSPACE</p>
            <h1 id="shortcut-title">Add a shortcut</h1>
            <p className="auth-subtitle">Save a website you want quick access to.</p>
            <form className="auth-form" onSubmit={submitShortcut}>
              <label>
                Name
                <input
                  autoFocus
                  maxLength={64}
                  onChange={(event) => setShortcutName(event.target.value)}
                  placeholder="e.g. Course portal"
                  required
                  value={shortcutName}
                />
              </label>
              <label>
                Website URL
                <input
                  autoComplete="url"
                  onChange={(event) => setShortcutUrl(event.target.value)}
                  placeholder="example.com"
                  required
                  type="text"
                  value={shortcutUrl}
                />
              </label>
              {shortcutError && <p className="auth-error" role="alert">{shortcutError}</p>}
              <button className="auth-submit" disabled={shortcutSubmitting} type="submit">
                {shortcutSubmitting ? 'Saving shortcut…' : 'Save shortcut'}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
