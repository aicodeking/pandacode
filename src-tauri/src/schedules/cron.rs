//! Cron expressions for task schedules: a five-field parser (minute, hour,
//! day-of-month, month, day-of-week) and the next fire time in a schedule's
//! IANA timezone, DST-correct: a nonexistent local time fires at the next
//! existing minute, an ambiguous one takes the earlier offset, and a match is
//! searched for at most five years out.

use chrono::{Datelike, Duration, Timelike};

/// Minutes of wall time a next-fire scan covers (five years, leap days included).
const SCAN_MINUTES: usize = 5 * 366 * 24 * 60;

/// A parsed five-field cron expression. Each field holds its sorted,
/// deduplicated values; an EMPTY field is `*` (unrestricted, matches any
/// value). `7` in day-of-week parses as Sunday, normalized to `0`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct CronExpr {
    pub(crate) minutes: Vec<u32>,
    pub(crate) hours: Vec<u32>,
    pub(crate) days_of_month: Vec<u32>,
    pub(crate) months: Vec<u32>,
    pub(crate) days_of_week: Vec<u32>,
}

const FIELDS: [(&str, u32, u32); 5] =
    [("minute", 0, 59), ("hour", 0, 23), ("day-of-month", 1, 31), ("month", 1, 12), ("day-of-week", 0, 7)];

/// Parses a five-field cron expression. Only `*`, `,` `-` and `/` are
/// supported (no names, no macros); errors name the first bad field, e.g.
/// "cron minute field: 60 is out of 0-59", and an expression that never fires
/// within five years is refused with "does not fire within 5 years".
pub(crate) fn parse_cron(expr: &str) -> Result<CronExpr, String> {
    let parsed = parse_fields(expr)?;
    if cron_next_fire(&parsed, "UTC", chrono::Utc::now().timestamp_millis()).is_none() {
        return Err("This cron expression does not fire within 5 years.".into());
    }
    Ok(parsed)
}

/// Parses a stored expression, trusting its shape to the validation that saved it;
/// `None` when it no longer parses.
pub(crate) fn parse(expr: &str) -> Option<CronExpr> {
    parse_fields(expr).ok()
}

fn parse_fields(expr: &str) -> Result<CronExpr, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "A cron expression is five fields (minute hour day-of-month month day-of-week); this one has {}.",
            fields.len()
        ));
    }
    let mut parsed = fields.iter().zip(FIELDS).map(|(text, (name, min, max))| field_values(name, min, max, text));
    let (minutes, hours) = (parsed.next().unwrap()?, parsed.next().unwrap()?);
    let (days_of_month, months) = (parsed.next().unwrap()?, parsed.next().unwrap()?);
    let days_of_week = parsed.next().unwrap()?.into_iter().map(|day| day % 7).collect::<Vec<_>>();
    Ok(CronExpr { minutes, hours, days_of_month, months, days_of_week })
}

/// One field's sorted values; a bare `*` stays empty (unrestricted).
fn field_values(name: &str, min: u32, max: u32, text: &str) -> Result<Vec<u32>, String> {
    if text == "*" {
        return Ok(Vec::new());
    }
    let mut values = Vec::new();
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step.parse().map_err(|_| format!("cron {name} field: {step} is not a number"))?;
                if step == 0 {
                    return Err(format!("cron {name} field: step must be 1 or more"));
                }
                (range, step)
            }
            None => (item, 1),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((first, last)) = range.split_once('-') {
            let (first, last) = (value(name, min, max, first)?, value(name, min, max, last)?);
            if first > last {
                return Err(format!("cron {name} field: {range} starts after it ends"));
            }
            (first, last)
        } else {
            let at = value(name, min, max, range)?;
            // "N/step" runs from N to the field's top, like Vixie cron.
            (at, if step > 1 { max } else { at })
        };
        let mut at = start;
        while at <= end {
            values.push(at);
            at = at.saturating_add(step);
        }
    }
    values.sort_unstable();
    values.dedup();
    Ok(values)
}

fn value(name: &str, min: u32, max: u32, text: &str) -> Result<u32, String> {
    let parsed: u32 = text.parse().map_err(|_| format!("cron {name} field: {text} is not a number"))?;
    if (min..=max).contains(&parsed) {
        Ok(parsed)
    } else {
        Err(format!("cron {name} field: {parsed} is out of {min}-{max}"))
    }
}

/// Whether a local wall-clock minute matches. When both day fields are restricted,
/// either one fires (Vixie OR); when either is `*`, both must match.
fn matches(expr: &CronExpr, at: chrono::NaiveDateTime) -> bool {
    let weekday = at.weekday().num_days_from_sunday();
    let dom = expr.days_of_month.contains(&at.day());
    let dow = expr.days_of_week.contains(&weekday);
    let day = if expr.days_of_month.is_empty() || expr.days_of_week.is_empty() {
        (expr.days_of_month.is_empty() || dom) && (expr.days_of_week.is_empty() || dow)
    } else {
        dom || dow
    };
    let in_field = |values: &[u32], unit: u32| values.is_empty() || values.contains(&unit);
    day && in_field(&expr.months, at.month()) && in_field(&expr.hours, at.hour()) && in_field(&expr.minutes, at.minute())
}

/// The next fire strictly after `after` (epoch ms), computed in `timezone`
/// (an IANA name; empty = this computer's zone); `None` when the expression
/// does not fire within five years. When both day-of-month and day-of-week are
/// restricted, either match fires (Vixie OR); when either is `*`, both must match.
pub(crate) fn cron_next_fire(expr: &CronExpr, timezone: &str, after: i64) -> Option<i64> {
    let zone = Zone::named(timezone)?;
    let mut minute = zone.wall(after)?.checked_add_signed(Duration::minutes(1))?;
    for _ in 0..SCAN_MINUTES {
        if matches(expr, minute) {
            return zone.fire(minute);
        }
        minute += Duration::minutes(1);
    }
    None
}

/// A schedule's zone: an IANA name, or the computer's own when none is set.
enum Zone {
    Local,
    Named(chrono_tz::Tz),
}

impl Zone {
    fn named(timezone: &str) -> Option<Self> {
        let name = timezone.trim();
        if name.is_empty() {
            return Some(Self::Local);
        }
        name.parse().ok().map(Self::Named)
    }

    /// The local wall time at epoch-ms `at`, truncated to the minute.
    fn wall(&self, at: i64) -> Option<chrono::NaiveDateTime> {
        match self {
            Self::Local => wall_of(&chrono::Local, at),
            Self::Named(tz) => wall_of(tz, at),
        }
    }

    /// The epoch ms at local wall time `at`: the earlier offset when the minute
    /// happens twice, `None` when it does not exist.
    fn instant(&self, at: chrono::NaiveDateTime) -> Option<i64> {
        match self {
            Self::Local => earliest(&chrono::Local, at),
            Self::Named(tz) => earliest(tz, at),
        }
    }

    /// When a matching minute sits in a spring-forward gap, the next existing
    /// minute fires instead.
    fn fire(&self, mut at: chrono::NaiveDateTime) -> Option<i64> {
        for _ in 0..2 * 24 * 60 {
            if let Some(at) = self.instant(at) {
                return Some(at);
            }
            at += Duration::minutes(1);
        }
        None
    }
}

fn wall_of<T: chrono::TimeZone>(tz: &T, at: i64) -> Option<chrono::NaiveDateTime> {
    let local = tz.timestamp_millis_opt(at).single()?;
    local.date_naive().and_hms_opt(local.hour(), local.minute(), 0)
}

/// The earlier of the offsets when `at` happens twice, `None` when it never does.
fn earliest<T: chrono::TimeZone>(tz: &T, at: chrono::NaiveDateTime) -> Option<i64> {
    match tz.from_local_datetime(&at) {
        chrono::LocalResult::Single(time) => Some(time.timestamp_millis()),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        use chrono::TimeZone;
        chrono::Utc.with_ymd_and_hms(year, month, day, hour, minute, 0).single().unwrap().timestamp_millis()
    }

    /// A wall time in a fixed-offset zone: +9 for Tokyo (no DST since 1951),
    /// -4/-5 for New York on daylight/standard time. chrono without chrono-tz
    /// has no tz database, so the test picks the offset, which is exact for
    /// these zones on these dates.
    fn zone(offset_hours: i32, year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        use chrono::TimeZone;
        chrono::FixedOffset::east_opt(offset_hours * 3600).unwrap().with_ymd_and_hms(year, month, day, hour, minute, 0).single().unwrap().timestamp_millis()
    }

    #[test]
    fn valid_expressions_parse() {
        for expr in [
            "*/15 9-17 * * 1-5",
            "0 9 * * *",
            "30 8 1 * *",
            "0 12 */2 * *",
            "59 23 31 12 *",
            "0 0 * * 0",
            "0 0 * * 7",
            "*/5 * * * *",
            "0 9,12,17 * * 1,3,5",
            "0 17,9 * * *",
        ] {
            match parse_cron(expr) {
                Ok(_) => {}
                Err(error) => panic!("expected {expr:?} to parse: {error}"),
            }
        }
    }

    #[test]
    fn fields_parse_and_seven_is_sunday() {
        let expr = parse_cron("*/15 9-17 * * 1-5").unwrap();
        assert_eq!(expr.minutes, [0, 15, 30, 45]);
        assert_eq!(expr.hours, (9..=17u32).collect::<Vec<_>>());
        assert_eq!(expr.days_of_week, [1, 2, 3, 4, 5]);
        assert!(expr.days_of_month.is_empty() && expr.months.is_empty(), "a star field is unrestricted");
        assert_eq!(parse_cron("0 0 * * 7").unwrap().days_of_week, [0], "7 is Sunday, normalized to 0");
        assert_eq!(parse_cron("0 0 * * 0").unwrap().days_of_week, [0]);
        assert_eq!(parse_cron("30 8 1 * *").unwrap().days_of_month, [1]);
        assert_eq!(parse_cron("59 23 31 12 *").unwrap().months, [12]);
    }

    #[test]
    fn out_of_range_values_name_the_first_bad_field() {
        let first = parse_cron("60 25 32 13 8").unwrap_err();
        assert!(first.starts_with("cron minute field"), "the first bad field is named: {first}");
        let contract = parse_cron("60 9 * * *").unwrap_err();
        assert!(contract.starts_with("cron minute field: 60 is out of 0-59"), "{contract}");
        for expr in ["* 24 * * *", "0 9 0 * *", "0 9 32 * *", "0 9 * 0 *", "0 9 * 13 *", "0 9 * * 8"] {
            match parse_cron(expr) {
                Err(error) => assert!(error.contains("cron"), "{expr}: {error}"),
                Ok(_) => panic!("expected {expr:?} to be rejected"),
            }
        }
    }

    #[test]
    fn names_macros_and_wrong_field_counts_are_rejected() {
        for expr in [
            "@hourly",
            "@daily",
            "0 9 * * MON",
            "0 9 * JAN *",
            "* * * * * *",
            "* * * *",
            "0 9 * *",
            "",
            "0 9 * * 1/L",
            "0 9 ? * *",
        ] {
            assert!(parse_cron(expr).is_err(), "{expr:?} parsed, but names, macros and wrong field counts are out of scope");
        }
    }

    #[test]
    fn expressions_that_never_fire_are_refused() {
        // February 30th and 31st never exist (dow is `*`, so Vixie OR cannot
        // rescue them; "30 2 30 2 1" would fire on February Mondays and is fine).
        for expr in ["0 5 30 2 *", "0 0 31 2 *"] {
            let error = parse_cron(expr).unwrap_err();
            assert!(error.contains("does not fire within 5 years"), "{expr}: {error}");
        }
    }

    #[test]
    fn next_fire_steps_through_the_window_and_skips_weekends() {
        let expr = parse_cron("*/15 9-17 * * 1-5").unwrap();
        // Thursday 2026-01-01.
        assert_eq!(cron_next_fire(&expr, "UTC", utc(2026, 1, 1, 12, 7)), Some(utc(2026, 1, 1, 12, 15)));
        // A slot is exclusive: firing at 12:15 means the next ask starts at 12:30.
        assert_eq!(cron_next_fire(&expr, "UTC", utc(2026, 1, 1, 12, 15)), Some(utc(2026, 1, 1, 12, 30)));
        // Past the window's last slot (17:45) the next day opens at 09:00.
        assert_eq!(cron_next_fire(&expr, "UTC", utc(2026, 1, 1, 17, 45)), Some(utc(2026, 1, 2, 9, 0)));
        // Friday's close steps over the weekend to Monday 2026-01-05.
        assert_eq!(cron_next_fire(&expr, "UTC", utc(2026, 1, 2, 17, 45)), Some(utc(2026, 1, 5, 9, 0)));
    }

    #[test]
    fn next_fire_runs_in_the_schedule_timezone() {
        let daily = parse_cron("0 9 * * *").unwrap();
        let after = utc(2026, 6, 15, 12, 0);
        // 21:00 in Tokyo: its next 09:00 is 2026-06-16 00:00 UTC.
        assert_eq!(cron_next_fire(&daily, "Asia/Tokyo", after), Some(zone(9, 2026, 6, 16, 9, 0)));
        // 08:00 in New York (EDT): its next 09:00 is 13:00 UTC the same morning.
        assert_eq!(cron_next_fire(&daily, "America/New_York", after), Some(zone(-4, 2026, 6, 15, 9, 0)));
    }

    #[test]
    fn next_fire_jumps_the_spring_forward_gap() {
        let expr = parse_cron("30 2 * * *").unwrap();
        // On 2026-03-08 New York's clock jumps 02:00 -> 03:00, so 02:30 does not
        // exist; the run fires at the next existing minute, 03:00 EDT (07:00 UTC).
        let fire = cron_next_fire(&expr, "America/New_York", utc(2026, 3, 7, 12, 0)).unwrap();
        assert_eq!(fire, zone(-4, 2026, 3, 8, 3, 0));
        // From there the next 02:30 exists again and stays on daylight time.
        assert_eq!(cron_next_fire(&expr, "America/New_York", fire), Some(zone(-4, 2026, 3, 9, 2, 30)));
    }

    #[test]
    fn next_fire_takes_the_earlier_offset_at_fall_back_and_fires_once() {
        let expr = parse_cron("30 1 * * *").unwrap();
        // 2026-11-01's 01:30 happens twice in New York (EDT, then again after the
        // 02:00 fall-back); the earlier offset wins.
        let fire = cron_next_fire(&expr, "America/New_York", utc(2026, 11, 1, 0, 0)).unwrap();
        assert_eq!(fire, zone(-4, 2026, 11, 1, 1, 30));
        // The ambiguous minute fires once: the next run is the following day's
        // 01:30 EST, not the second pass of this day's.
        assert_eq!(cron_next_fire(&expr, "America/New_York", fire), Some(zone(-5, 2026, 11, 2, 1, 30)));
    }

    #[test]
    fn restricted_dom_and_dow_match_either() {
        let either = parse_cron("0 0 13 * 5").unwrap();
        // 2026-01-09 is a Friday and the 13th a Tuesday: with both day fields
        // restricted, either one matches (Vixie OR), so the 13th follows the 9th.
        assert_eq!(cron_next_fire(&either, "UTC", utc(2026, 1, 9, 0, 0)), Some(utc(2026, 1, 13, 0, 0)));
        // ... and the Friday after the 13th still matches on its weekday alone.
        assert_eq!(cron_next_fire(&either, "UTC", utc(2026, 1, 13, 0, 0)), Some(utc(2026, 1, 16, 0, 0)));
        // One restricted field does not broaden: Fridays only, then the 13ths only.
        let fridays = parse_cron("0 0 * * 5").unwrap();
        assert_eq!(cron_next_fire(&fridays, "UTC", utc(2026, 1, 9, 0, 0)), Some(utc(2026, 1, 16, 0, 0)));
        let thirteenths = parse_cron("0 0 13 * *").unwrap();
        assert_eq!(cron_next_fire(&thirteenths, "UTC", utc(2026, 1, 13, 0, 0)), Some(utc(2026, 2, 13, 0, 0)));
    }

    #[test]
    fn no_fire_within_five_years_is_none() {
        // February 30th never exists: the five-year scan comes back empty. The
        // expression is built directly because parse_cron refuses it outright.
        let february = CronExpr { minutes: vec![5], hours: vec![0], days_of_month: vec![30], months: vec![2], ..Default::default() };
        assert_eq!(cron_next_fire(&february, "UTC", utc(2026, 1, 1, 0, 0)), None);
    }
}
