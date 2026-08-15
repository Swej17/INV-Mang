# Desktop shell (Phase 2)

This package reserves the native macOS application boundary for Phase 2. Phase 1 must not
add Tauri code or desktop-specific branches to shared packages. The desktop shell will consume
the same domain, contracts, application, synchronization, persistence contracts, UI, and test
fixtures as the web application.
