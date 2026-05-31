pub fn backoff_ms(run_number: i64, cap_ms: u64) -> u64 {
    let exponent = run_number.saturating_sub(1).clamp(0, 16) as u32;
    let base = 1_000_u64.saturating_mul(2_u64.saturating_pow(exponent));
    base.min(cap_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_backoff() {
        assert_eq!(backoff_ms(1, 300_000), 1_000);
        assert_eq!(backoff_ms(20, 10_000), 10_000);
    }
}
