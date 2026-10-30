use std::{
    collections::HashSet,
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use tracing::{error, info, warn};

const SESSION_SECONDS: i64 = 60 * 60 * 24 * 7;
const MAX_FAVICON_BYTES: usize = 64 * 1024;
const MAX_WEBSITE_HTML_BYTES: usize = 512 * 1024;
const MAX_UNIVERSITY_TOKEN_BYTES: usize = 16 * 1024;

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    dummy_password_hash: String,
    secure_cookie: bool,
    http_client: Client,
    jwt_cipher: Option<Arc<Aes256Gcm>>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, message: &'static str) -> Self {
        Self { status, message }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        error!("internal request error: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal server error occurred.",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[derive(Deserialize)]
struct RegisterRequest {
    username: String,
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct User {
    id: String,
    username: String,
    email: String,
}

#[derive(Serialize)]
struct UserResponse {
    user: User,
}

#[derive(Serialize)]
struct OptionalUserResponse {
    user: Option<User>,
}

#[derive(Deserialize)]
struct CreateShortcutRequest {
    name: String,
    url: String,
}

#[derive(Serialize)]
struct Shortcut {
    id: String,
    name: String,
    url: String,
    icon_data: Option<String>,
}

#[derive(Serialize)]
struct ShortcutsResponse {
    shortcuts: Vec<Shortcut>,
}

#[derive(Serialize)]
struct ShortcutResponse {
    shortcut: Shortcut,
}

#[derive(Deserialize)]
struct SaveNoteRequest {
    title: String,
    content: String,
    pinned: bool,
}

#[derive(Serialize)]
struct Note {
    id: String,
    title: String,
    content: String,
    pinned: bool,
    updated_at: i64,
}

#[derive(Serialize)]
struct NotesResponse {
    notes: Vec<Note>,
}

#[derive(Serialize)]
struct NoteResponse {
    note: Note,
}

#[derive(Deserialize)]
struct CreateTaskRequest {
    text: String,
}

#[derive(Deserialize)]
struct UpdateTaskRequest {
    completed: bool,
}

#[derive(Serialize)]
struct Task {
    id: String,
    text: String,
    completed: bool,
    created_at: i64,
}

#[derive(Serialize)]
struct TasksResponse {
    tasks: Vec<Task>,
}

#[derive(Serialize)]
struct TaskResponse {
    task: Task,
}

#[derive(Deserialize)]
struct SaveUniversityTokenRequest {
    token: String,
}

#[derive(Serialize)]
struct UniversityTokenStatus {
    enabled: bool,
    saved: bool,
    updated_at: Option<i64>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            env::var("RUST_LOG")
                .unwrap_or_else(|_| "studyspace_backend=info,tower_http=info".into()),
        )
        .init();

    let data_dir = env::var_os("STUDYSPACE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data"));
    std::fs::create_dir_all(&data_dir)?;
    let database_path = data_dir.join("studyspace.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY NOT NULL,
            username TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS university_tokens (
            user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at)")
        .execute(&pool)
        .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS shortcuts (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            icon_data TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(user_id, url)
        )",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY NOT NULL,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    let dummy_password_hash = hash_password("not-a-real-user-password")
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let secure_cookie = env::var("COOKIE_SECURE")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let http_client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(4))
        .no_proxy()
        .build()?;
    let jwt_cipher = match env::var("JWT_ENCRYPTION_KEY") {
        Ok(value) => {
            let key = parse_encryption_key(&value)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let cipher = Aes256Gcm::new_from_slice(&key)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            Some(Arc::new(cipher))
        }
        Err(env::VarError::NotPresent) => None,
        Err(error) => return Err(std::io::Error::other(error.to_string()).into()),
    };
    let state = AppState {
        pool,
        dummy_password_hash,
        secure_cookie,
        http_client,
        jwt_cipher,
    };
    let app = Router::new()
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(current_user))
        .route("/api/shortcuts", get(list_shortcuts).post(create_shortcut))
        .route(
            "/api/shortcuts/{id}",
            axum::routing::delete(delete_shortcut),
        )
        .route("/api/notes", get(list_notes).post(create_note))
        .route(
            "/api/notes/{id}",
            axum::routing::put(update_note).delete(delete_note),
        )
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route(
            "/api/tasks/{id}",
            axum::routing::patch(update_task).delete(delete_task),
        )
        .route(
            "/api/integrations/university/token",
            get(university_token_status)
                .put(save_university_token)
                .delete(delete_university_token),
        )
        .with_state(state);

    let address = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let address: SocketAddr = address.parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!("Studyspace backend listening on http://{address}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn register(
    State(state): State<AppState>,
    request: Result<Json<RegisterRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let username = request.username.trim();
    let email = normalize_email(&request.email)?;
    validate_username(username)?;
    validate_password(&request.password)?;

    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    if existing.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "An account with that email already exists.",
        ));
    }

    let id = random_token();
    let password_hash = hash_password(request.password)
        .await
        .map_err(ApiError::internal)?;
    let created_at = now()?;
    let result = sqlx::query(
        "INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(username)
    .bind(&email)
    .bind(&password_hash)
    .bind(created_at)
    .execute(&state.pool)
    .await;

    if let Err(error) = result {
        if let sqlx::Error::Database(database_error) = &error {
            if database_error.is_unique_violation() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "An account with that email already exists.",
                ));
            }
        }
        return Err(ApiError::internal(error));
    }

    let user = User {
        id,
        username: username.to_owned(),
        email,
    };
    let token = create_session(&state, &user.id).await?;
    let mut response = (StatusCode::CREATED, Json(UserResponse { user })).into_response();
    set_session_cookie(&mut response, &token, state.secure_cookie)?;
    Ok(response)
}

async fn login(
    State(state): State<AppState>,
    request: Result<Json<LoginRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let email = normalize_email(&request.email)?;
    if request.password.is_empty() || request.password.chars().count() > 128 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Email or password is invalid.",
        ));
    }

    let row = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, username, email, password_hash FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    let hash_to_check = row
        .as_ref()
        .map(|(_, _, _, password_hash)| password_hash.clone())
        .unwrap_or_else(|| state.dummy_password_hash.clone());
    let password = request.password;
    let verified = tokio::task::spawn_blocking(move || verify_password(&password, &hash_to_check))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let Some((id, username, email, _)) = row.filter(|_| verified) else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Email or password is incorrect.",
        ));
    };

    let user = User {
        id,
        username,
        email,
    };
    let token = create_session(&state, &user.id).await?;
    let mut response = Json(UserResponse { user }).into_response();
    set_session_cookie(&mut response, &token, state.secure_cookie)?;
    Ok(response)
}

async fn current_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OptionalUserResponse>, ApiError> {
    let Some(token) = session_token(&headers) else {
        return Ok(Json(OptionalUserResponse { user: None }));
    };
    let token_hash = hash_token(&token);
    let user = sqlx::query_as::<_, (String, String, String)>(
        "SELECT users.id, users.username, users.email
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    )
    .bind(token_hash)
    .bind(now()?)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?
    .map(|(id, username, email)| User {
        id,
        username,
        email,
    });
    Ok(Json(OptionalUserResponse { user }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_session_cookie(&mut response, state.secure_cookie)?;
    Ok(response)
}

async fn list_shortcuts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        "SELECT id, name, url, icon_data FROM shortcuts
         WHERE user_id = ? ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let shortcuts = rows
        .into_iter()
        .map(|(id, name, url, icon_data)| Shortcut {
            id,
            name,
            url,
            icon_data,
        })
        .collect();
    let mut response = Json(ShortcutsResponse { shortcuts }).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn create_shortcut(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<CreateShortcutRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Name must be between 1 and 64 characters.",
        ));
    }
    let url = normalize_shortcut_url(&request.url)?;
    let icon_data = match fetch_favicon(&state.http_client, &url).await {
        Ok(icon) => icon,
        Err(reason) => {
            warn!("Could not retrieve favicon for shortcut host: {reason}");
            None
        }
    };

    let id = random_token();
    let created_at = now()?;
    let result = sqlx::query(
        "INSERT INTO shortcuts (id, user_id, name, url, icon_data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(name)
    .bind(&url)
    .bind(&icon_data)
    .bind(created_at)
    .execute(&state.pool)
    .await;

    if let Err(error) = result {
        if let sqlx::Error::Database(database_error) = &error {
            if database_error.is_unique_violation() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "That URL is already in your shortcuts.",
                ));
            }
        }
        return Err(ApiError::internal(error));
    }

    let mut response = (
        StatusCode::CREATED,
        Json(ShortcutResponse {
            shortcut: Shortcut {
                id,
                name: name.to_owned(),
                url,
                icon_data,
            },
        }),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn delete_shortcut(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM shortcuts WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Shortcut not found."));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn list_notes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, String, bool, i64)>(
        "SELECT id, title, content, pinned, updated_at FROM notes
         WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC, id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let notes = rows
        .into_iter()
        .map(|(id, title, content, pinned, updated_at)| Note {
            id,
            title,
            content,
            pinned,
            updated_at,
        })
        .collect();
    let mut response = Json(NotesResponse { notes }).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn create_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<SaveNoteRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let (title, content) = validate_note_fields(&request.title, &request.content)?;
    let id = random_token();
    let updated_at = now()?;
    sqlx::query(
        "INSERT INTO notes (id, user_id, title, content, pinned, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(title)
    .bind(content)
    .bind(request.pinned)
    .bind(updated_at)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    let mut response = (
        StatusCode::CREATED,
        Json(NoteResponse {
            note: Note {
                id,
                title: title.to_owned(),
                content: content.to_owned(),
                pinned: request.pinned,
                updated_at,
            },
        }),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn update_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<SaveNoteRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let (title, content) = validate_note_fields(&request.title, &request.content)?;
    let updated_at = now()?;
    let result = sqlx::query(
        "UPDATE notes SET title = ?, content = ?, pinned = ?, updated_at = ?
         WHERE id = ? AND user_id = ?",
    )
    .bind(title)
    .bind(content)
    .bind(request.pinned)
    .bind(updated_at)
    .bind(&id)
    .bind(&user_id)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Note not found."));
    }

    let mut response = Json(NoteResponse {
        note: Note {
            id,
            title: title.to_owned(),
            content: content.to_owned(),
            pinned: request.pinned,
            updated_at,
        },
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn delete_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM notes WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Note not found."));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn validate_note_fields<'a>(
    title: &'a str,
    content: &'a str,
) -> Result<(&'a str, &'a str), ApiError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Note title must be between 1 and 120 characters.",
        ));
    }
    if content.chars().count() > 50_000 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Note content must be 50,000 characters or fewer.",
        ));
    }
    Ok((title, content))
}

async fn list_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let rows = sqlx::query_as::<_, (String, String, bool, i64)>(
        "SELECT id, text, completed, created_at FROM tasks
         WHERE user_id = ? ORDER BY completed, created_at DESC, id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let tasks = rows
        .into_iter()
        .map(|(id, text, completed, created_at)| Task {
            id,
            text,
            completed,
            created_at,
        })
        .collect();
    let mut response = Json(TasksResponse { tasks }).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn create_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<CreateTaskRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let text = validate_task_text(&request.text)?;
    let id = random_token();
    let created_at = now()?;
    sqlx::query(
        "INSERT INTO tasks (id, user_id, text, completed, created_at)
         VALUES (?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(text)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    let mut response = (
        StatusCode::CREATED,
        Json(TaskResponse {
            task: Task {
                id,
                text: text.to_owned(),
                completed: false,
                created_at,
            },
        }),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn update_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    request: Result<Json<UpdateTaskRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let result = sqlx::query("UPDATE tasks SET completed = ? WHERE id = ? AND user_id = ?")
        .bind(request.completed)
        .bind(&id)
        .bind(&user_id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Task not found."));
    }

    let task_data = sqlx::query_as::<_, (String, i64)>(
        "SELECT text, created_at FROM tasks WHERE id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let Some((text, created_at)) = task_data else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Task not found."));
    };
    let mut response = Json(TaskResponse {
        task: Task {
            id,
            text,
            completed: request.completed,
            created_at,
        },
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn delete_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let result = sqlx::query("DELETE FROM tasks WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Task not found."));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn validate_task_text(text: &str) -> Result<&str, ApiError> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 300 || text.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Task must be between 1 and 300 characters.",
        ));
    }
    Ok(text)
}

async fn authenticated_user_id(state: &AppState, headers: &HeaderMap) -> Result<String, ApiError> {
    let Some(token) = session_token(headers) else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Log in to manage your workspace.",
        ));
    };
    let user_id: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
            .bind(hash_token(&token))
            .bind(now()?)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    user_id
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Log in to manage your workspace."))
}

async fn university_token_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let updated_at: Option<i64> =
        sqlx::query_scalar("SELECT updated_at FROM university_tokens WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    let mut response = Json(UniversityTokenStatus {
        enabled: state.jwt_cipher.is_some(),
        saved: updated_at.is_some(),
        updated_at,
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn save_university_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Result<Json<SaveUniversityTokenRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    let cipher = state.jwt_cipher.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "University token storage is not configured on the backend.",
        )
    })?;
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Request body must contain valid JSON.",
        )
    })?;
    let token = request.token.trim();
    validate_university_token(token)?;
    let (nonce, ciphertext) = encrypt_university_token(cipher, token)?;
    let updated_at = now()?;

    sqlx::query(
        "INSERT INTO university_tokens (user_id, nonce, ciphertext, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
            nonce = excluded.nonce,
            ciphertext = excluded.ciphertext,
            updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(nonce)
    .bind(ciphertext)
    .bind(updated_at)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    let mut response = Json(UniversityTokenStatus {
        enabled: true,
        saved: true,
        updated_at: Some(updated_at),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn delete_university_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UniversityTokenStatus>, ApiError> {
    let user_id = authenticated_user_id(&state, &headers).await?;
    sqlx::query("DELETE FROM university_tokens WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(UniversityTokenStatus {
        enabled: state.jwt_cipher.is_some(),
        saved: false,
        updated_at: None,
    }))
}

fn parse_encryption_key(value: &str) -> Result<[u8; 32], &'static str> {
    if value.len() != 64 {
        return Err("JWT_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes).");
    }
    let mut key = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = (pair[0] as char)
            .to_digit(16)
            .ok_or("JWT_ENCRYPTION_KEY must be hexadecimal.")?;
        let low = (pair[1] as char)
            .to_digit(16)
            .ok_or("JWT_ENCRYPTION_KEY must be hexadecimal.")?;
        key[index] = ((high << 4) | low) as u8;
    }
    Ok(key)
}

fn validate_university_token(token: &str) -> Result<(), ApiError> {
    if token.len() > MAX_UNIVERSITY_TOKEN_BYTES {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "University token must be 16 KB or smaller.",
        ));
    }
    if token.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "University token cannot be empty.",
        ));
    }
    if token
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "University token must not contain whitespace or control characters.",
        ));
    }
    Ok(())
}

fn encrypt_university_token(cipher: &Aes256Gcm, token: &str) -> Result<(String, String), ApiError> {
    let mut nonce_bytes = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, token.as_bytes())
        .map_err(ApiError::internal)?;
    Ok((
        URL_SAFE_NO_PAD.encode(nonce_bytes),
        URL_SAFE_NO_PAD.encode(ciphertext),
    ))
}

fn normalize_shortcut_url(input: &str) -> Result<String, ApiError> {
    let input = input.trim();
    if input.is_empty() || input.len() > 2048 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Enter a valid website URL.",
        ));
    }
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let mut url = Url::parse(&candidate)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Enter a valid website URL."))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port().is_some()
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Only public HTTP or HTTPS website URLs are supported.",
        ));
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

async fn fetch_favicon(client: &Client, url: &str) -> Result<Option<String>, String> {
    let website_url = Url::parse(url).map_err(|error| error.to_string())?;
    let host = website_url
        .host_str()
        .ok_or_else(|| "URL has no host".to_owned())?
        .to_owned();
    let port = website_url
        .port_or_known_default()
        .ok_or_else(|| "URL has an unsupported port".to_owned())?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err("favicon host does not resolve to a public address".to_owned());
        }
        Vec::new()
    } else {
        let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|error| format!("DNS lookup failed: {error}"))?
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if resolved.is_empty() || resolved.iter().any(|address| !is_public_ip(address.ip())) {
            return Err("favicon host does not resolve exclusively to public addresses".to_owned());
        }
        resolved
    };

    let request_client = if addresses.is_empty() {
        client.clone()
    } else {
        Client::builder()
            .redirect(Policy::none())
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(4))
            .no_proxy()
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|error| error.to_string())?
    };

    let mut candidates = Vec::new();
    match request_client.get(website_url.clone()).send().await {
        Ok(response) => {
            if response.status().is_success()
                && response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with("text/html"))
            {
                let mut response = response;
                let mut html = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|error| format!("could not read website response: {error}"))?
                {
                    if html.len() + chunk.len() > MAX_WEBSITE_HTML_BYTES {
                        break;
                    }
                    html.extend_from_slice(&chunk);
                }
                if !html.is_empty() {
                    candidates.extend(discover_favicon_urls(
                        &String::from_utf8_lossy(&html),
                        &website_url,
                    ));
                }
            }
        }
        Err(error) => warn!("Could not inspect website for favicon links: {error}"),
    }

    let mut conventional_favicon = website_url.clone();
    conventional_favicon.set_path("/favicon.ico");
    conventional_favicon.set_query(None);
    conventional_favicon.set_fragment(None);
    if !candidates.contains(&conventional_favicon) {
        candidates.push(conventional_favicon);
    }

    for favicon_url in candidates {
        match fetch_icon_data(&request_client, favicon_url).await {
            Ok(Some(icon_data)) => return Ok(Some(icon_data)),
            Ok(None) => {}
            Err(error) => warn!("Could not retrieve discovered favicon: {error}"),
        }
    }
    Ok(None)
}

fn discover_favicon_urls(html: &str, website_url: &Url) -> Vec<Url> {
    let document = scraper::Html::parse_document(html);
    let selector =
        scraper::Selector::parse("link[href]").expect("static favicon selector is valid");
    let mut candidates = Vec::new();

    for element in document.select(&selector) {
        let rel = element.value().attr("rel").unwrap_or_default();
        if !rel
            .split_ascii_whitespace()
            .any(|value| matches!(value.to_ascii_lowercase().as_str(), "icon" | "shortcut"))
        {
            continue;
        }

        let Some(href) = element.value().attr("href") else {
            continue;
        };
        let Ok(icon_url) = website_url.join(href) else {
            continue;
        };
        if !matches!(icon_url.scheme(), "http" | "https")
            || !icon_url.username().is_empty()
            || icon_url.password().is_some()
            || icon_url.origin() != website_url.origin()
        {
            continue;
        }
        if !candidates.contains(&icon_url) {
            candidates.push(icon_url);
        }
    }

    candidates
}

async fn fetch_icon_data(client: &Client, favicon_url: Url) -> Result<Option<String>, String> {
    let response = client
        .get(favicon_url)
        .send()
        .await
        .map_err(|error| format!("favicon request failed: {error}"))?;
    if !response.status().is_success() {
        return Ok(None);
    }

    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        content_type.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
            | "image/avif"
            | "image/svg+xml"
    ) {
        return Ok(None);
    }

    if response
        .content_length()
        .is_some_and(|length| length > MAX_FAVICON_BYTES as u64)
    {
        return Ok(None);
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("could not read favicon response: {error}"))?
    {
        if bytes.len() + chunk.len() > MAX_FAVICON_BYTES {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:{content_type};base64,{encoded}")))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && !ip.is_multicast()
                && a != 0
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && c == 0)
                && !(a == 192 && b == 0 && c == 2)
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 198 && b == 51 && c == 100)
                && !(a == 203 && b == 0 && c == 113)
                && a < 240
        }
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(ipv4));
            }
            let segments = ip.segments();
            (segments[0] & 0xe000) == 0x2000
                && !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
                && !(segments[0] == 0x2001 && matches!(segments[1], 0x0000 | 0x0db8))
                && segments[0] != 0x2002
        }
    }
}

fn validate_username(username: &str) -> Result<(), ApiError> {
    let length = username.chars().count();
    if !(2..=32).contains(&length) || username.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Username must be 2–32 characters and contain no control characters.",
        ));
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    let length = password.chars().count();
    if !(8..=128).contains(&length) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Password must be between 8 and 128 characters.",
        ));
    }
    Ok(())
}

fn normalize_email(email: &str) -> Result<String, ApiError> {
    let email = email.trim().to_ascii_lowercase();
    let Some((local, domain)) = email.split_once('@') else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Enter a valid email address.",
        ));
    };
    if email.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || !domain.contains('.')
        || email.chars().any(char::is_whitespace)
        || email.matches('@').count() != 1
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Enter a valid email address.",
        ));
    }
    Ok(email)
}

async fn hash_password(
    password: impl Into<String>,
) -> Result<String, argon2::password_hash::Error> {
    let password = password.into();
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
    })
    .await
    .map_err(|_| argon2::password_hash::Error::Crypto)?
}

fn verify_password(password: &str, hash: &str) -> Result<bool, argon2::password_hash::Error> {
    let parsed_hash = PasswordHash::new(hash)?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie_header
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| {
            (name == "studyspace_session" && !value.is_empty()).then(|| value.to_owned())
        })
}

async fn create_session(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let token = random_token();
    let expires_at = now()?
        .checked_add(SESSION_SECONDS)
        .ok_or_else(|| ApiError::internal("session expiry overflow"))?;
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(expires_at)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(token)
}

fn now() -> Result<i64, ApiError> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(ApiError::internal)?
        .as_secs();
    i64::try_from(timestamp).map_err(ApiError::internal)
}

fn set_session_cookie(response: &mut Response, token: &str, secure: bool) -> Result<(), ApiError> {
    let secure_attribute = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "studyspace_session={token}; HttpOnly; SameSite=Lax; Path=/api; Max-Age={SESSION_SECONDS}{secure_attribute}"
    );
    let value = HeaderValue::from_str(&cookie)
        .map_err(|_| ApiError::internal("invalid session cookie header"))?;
    response.headers_mut().insert(header::SET_COOKIE, value);
    Ok(())
}

fn clear_session_cookie(response: &mut Response, secure: bool) -> Result<(), ApiError> {
    let secure_attribute = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "studyspace_session=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0{secure_attribute}"
    );
    let value = HeaderValue::from_str(&cookie)
        .map_err(|_| ApiError::internal("invalid session cookie header"))?;
    response.headers_mut().insert(header::SET_COOKIE, value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        encrypt_university_token, is_public_ip, normalize_email, normalize_shortcut_url,
        parse_encryption_key, validate_note_fields, validate_password, validate_task_text,
        validate_university_token, validate_username,
    };
    use aes_gcm::{
        Aes256Gcm, Nonce,
        aead::{Aead, KeyInit},
    };
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use std::net::IpAddr;

    #[test]
    fn email_is_normalized_and_validated() {
        assert_eq!(
            normalize_email("  STUDENT@example.com ").unwrap(),
            "student@example.com"
        );
        assert!(normalize_email("not-an-email").is_err());
    }

    #[test]
    fn username_and_password_limits_are_enforced() {
        assert!(validate_username("Sam").is_ok());
        assert!(validate_username(" ").is_err());
        assert!(validate_password("password1").is_ok());
        assert!(validate_password("short").is_err());
    }

    #[test]
    fn note_titles_and_content_are_bounded() {
        assert_eq!(
            validate_note_fields("  Lecture notes  ", "Topic one").unwrap(),
            ("Lecture notes", "Topic one")
        );
        assert!(validate_note_fields(" ", "content").is_err());
        assert!(validate_note_fields(&"t".repeat(121), "content").is_err());
        assert!(validate_note_fields("Title", &"x".repeat(50_001)).is_err());
    }

    #[test]
    fn task_text_is_trimmed_and_bounded() {
        assert_eq!(
            validate_task_text("  Review lecture  ").unwrap(),
            "Review lecture"
        );
        assert!(validate_task_text(" ").is_err());
        assert!(validate_task_text(&"t".repeat(301)).is_err());
        assert!(validate_task_text("task\nwith newline").is_err());
    }

    #[test]
    fn shortcut_urls_are_normalized_and_reject_unsafe_schemes() {
        assert_eq!(
            normalize_shortcut_url("example.com").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_shortcut_url("https://example.com/study#section").unwrap(),
            "https://example.com/study"
        );
        assert!(normalize_shortcut_url("javascript:alert(1)").is_err());
        assert!(normalize_shortcut_url("https://user:pass@example.com").is_err());
        assert!(normalize_shortcut_url("http://example.com:8080").is_err());
    }

    #[test]
    fn favicon_fetch_ip_policy_rejects_non_public_addresses() {
        let public: IpAddr = "1.1.1.1".parse().unwrap();
        let private: IpAddr = "10.0.0.1".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let metadata: IpAddr = "169.254.169.254".parse().unwrap();
        assert!(is_public_ip(public));
        assert!(!is_public_ip(private));
        assert!(!is_public_ip(loopback));
        assert!(!is_public_ip(metadata));
    }

    #[test]
    fn favicon_discovery_only_accepts_same_origin_links() {
        let website_url = super::Url::parse("https://example.com/study/page").unwrap();
        let html = r#"
            <link rel="icon" href="/assets/site-icon.png">
            <link rel="shortcut icon" href="../favicon.svg">
            <link rel="icon" href="https://icons.example.net/icon.png">
            <link rel="icon" href="javascript:alert(1)">
        "#;
        let urls = super::discover_favicon_urls(html, &website_url);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].as_str(), "https://example.com/assets/site-icon.png");
        assert_eq!(urls[1].as_str(), "https://example.com/favicon.svg");
    }

    #[test]
    fn jwt_encryption_key_requires_32_bytes_of_hex() {
        assert_eq!(parse_encryption_key(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(parse_encryption_key("too-short").is_err());
        assert!(parse_encryption_key(&"xz".repeat(32)).is_err());
    }

    #[test]
    fn opaque_university_tokens_are_accepted() {
        assert!(validate_university_token("A1B2C3D4E5F6-m1.alunosW2").is_ok());
        assert!(validate_university_token("").is_err());
        assert!(validate_university_token("token with spaces").is_err());
        assert!(validate_university_token("token\nwith newline").is_err());
    }

    #[test]
    fn university_tokens_are_encrypted_before_storage() {
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln";
        assert!(validate_university_token(token).is_ok());
        assert!(validate_university_token("not-a-jwt").is_ok());

        let cipher = Aes256Gcm::new_from_slice(&[42; 32]).unwrap();
        let (encoded_nonce, encoded_ciphertext) = encrypt_university_token(&cipher, token).unwrap();
        assert!(!encoded_ciphertext.contains(token));
        let nonce_bytes = URL_SAFE_NO_PAD.decode(encoded_nonce).unwrap();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = URL_SAFE_NO_PAD.decode(encoded_ciphertext).unwrap();
        let plaintext = cipher.decrypt(nonce, ciphertext.as_ref()).unwrap();
        assert_eq!(String::from_utf8(plaintext).unwrap(), token);
    }
}
