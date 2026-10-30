use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
}

impl AppError {
    pub fn bad(message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_REQUEST",
            message,
        }
    }
    pub fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "UNAUTHORIZED",
            message: "Authentication required or credentials invalid.",
        }
    }
    pub fn forbidden() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "FORBIDDEN",
            message: "Request origin or CSRF token is invalid.",
        }
    }
    pub fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "NOT_FOUND",
            message: "Flag or environment was not found.",
        }
    }
    pub fn conflict(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message,
        }
    }
    pub fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "UNAVAILABLE",
            message: "Service is temporarily unavailable.",
        }
    }
    pub fn throttle() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "RATE_LIMITED",
            message: "Too many sign-in attempts. Try again later.",
        }
    }
    pub fn internal() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "INTERNAL_ERROR",
            message: "The operation could not be completed.",
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(_: tokio_postgres::Error) -> Self {
        Self::internal()
    }
}
impl From<deadpool_postgres::PoolError> for AppError {
    fn from(_: deadpool_postgres::PoolError) -> Self {
        Self::unavailable()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
