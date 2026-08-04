// Pure client platform: tests run against the tauri code paths; the
// SQLite db layer is mocked per test (StorageService falls back to the
// in-memory cache when no mock is injected).

import '@testing-library/jest-dom'
