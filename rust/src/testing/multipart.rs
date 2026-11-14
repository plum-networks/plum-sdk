//! Just enough `multipart/form-data` reading for the fake box's
//! `/api/drive/upload`.

pub(super) struct Parts {
    fields: Vec<(String, String)>,
    files: Vec<(String, String, Vec<u8>)>,
}

impl Parts {
    /// A plain field's value.
    pub(super) fn field(&self, name: &str) -> Option<String> {
        self.fields
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
    }

    /// A file part: its file name and bytes.
    pub(super) fn file(&self, name: &str) -> Option<(String, Vec<u8>)> {
        self.files
            .iter()
            .find(|(n, _, _)| n == name)
            .map(|(_, f, d)| (f.clone(), d.clone()))
    }
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// `name="…"` out of a `Content-Disposition` line.
fn param(line: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=\"");
    let start = line.find(&pat)? + pat.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_owned())
}

pub(super) fn parse(content_type: &str, body: &[u8]) -> Option<Parts> {
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("boundary="))?
        .trim_matches('"');
    let delim = format!("--{boundary}").into_bytes();
    let mut parts = Parts {
        fields: Vec::new(),
        files: Vec::new(),
    };
    let mut at = find(body, &delim, 0)? + delim.len();
    loop {
        if body[at..].starts_with(b"--") {
            return Some(parts);
        }
        at = find(body, b"\r\n", at)? + 2;
        let head_end = find(body, b"\r\n\r\n", at)?;
        let head = std::str::from_utf8(&body[at..head_end]).ok()?;
        let content_start = head_end + 4;
        let next = find(body, &[b"\r\n".as_slice(), &delim].concat(), content_start)?;
        let content = body[content_start..next].to_vec();
        let disposition = head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("content-disposition:"))?;
        let name = param(disposition, "name")?;
        match param(disposition, "filename") {
            Some(filename) => parts.files.push((name, filename, content)),
            None => parts
                .fields
                .push((name, String::from_utf8_lossy(&content).into_owned())),
        }
        at = next + 2 + delim.len();
    }
}
