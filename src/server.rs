//! Small HTTP server exposing the existing `NcmClient` API to the browser UI.
//!
//! This intentionally uses only the standard library for HTTP.  All calls to
//! NetEase are made through the same Rust client as the GTK application.

use crate::ncmapi::NcmClient;
use gtk::glib;
use ncm_api::{PlayListDetail, SongInfo, SongList};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
static INDEX_HTML: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/server/public/index.html"));
static APP_JS: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/server/public/app.js"));
static PLAYER_STATE_JS: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/server/public/player-state.js"));
static STYLE_CSS: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/server/public/style.css"));

fn secure_url(url: &str) -> String {
    if url.starts_with("https://") {
        url.to_owned()
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("https://{rest}")
    } else {
        String::new()
    }
}

fn song_json(song: &SongInfo) -> Value {
    json!({
        "id": song.id,
        "name": song.name,
        "artists": song.singer,
        "album": song.album,
        "cover": secure_url(&song.pic_url),
        "duration": song.duration,
    })
}

fn playlist_json(item: &SongList) -> Value {
    json!({
        "id": item.id,
        "name": item.name,
        "cover": secure_url(&item.cover_img_url),
        "author": item.author,
        "specialType": item.special_type,
    })
}

fn response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8], head: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; img-src 'self' https:; media-src 'self' https:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head {
        let _ = stream.write_all(body);
    }
}

fn json_response(stream: &mut TcpStream, status: &str, value: Value, head: bool) {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
    response(stream, status, "application/json; charset=utf-8", &body, head);
}

fn decode_component(value: &str) -> Option<String> {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            c if c.is_ascii() => out.push(c),
            _ => return None,
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').filter_map(|pair| pair.split_once('=')).find_map(|(key, value)| {
        (decode_component(key).as_deref() == Some(name)).then(|| decode_component(value)).flatten()
    })
}

fn form_param(body: &str, name: &str) -> Option<String> {
    query_param(body, name)
}

fn run_request(mut stream: TcpStream, client: &Arc<Mutex<NcmClient>>, qr_key: &Arc<Mutex<Option<String>>>) {
    let mut request = [0_u8; 64 * 1024];
    let size = match stream.read(&mut request) {
        Ok(size) if size > 0 => size,
        _ => return,
    };
    let line = match std::str::from_utf8(&request[..size]).ok().and_then(|r| r.lines().next()) {
        Some(line) => line,
        None => {
            response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", b"bad request", false);
            return;
        }
    };
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let head = method == "HEAD";
    if method != "GET" && method != "POST" && !head {
        json_response(&mut stream, "405 Method Not Allowed", json!({ "error": "不支持此请求方式" }), false);
        return;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));

    // Read an optional request body (used by credential login). The tiny HTTP
    // server intentionally accepts JSON and application/x-www-form-urlencoded.
    let body = std::str::from_utf8(&request[..size])
        .ok()
        .and_then(|raw| raw.split_once("\r\n\r\n").map(|(_, body)| body))
        .unwrap_or("");

    if path == "/api/health" {
        json_response(&mut stream, "200 OK", json!({ "status": "ok" }), head);
        return;
    }

    if path == "/api/login/qr/create" {
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let (url, key) = glib::MainContext::default().block_on(guard.client.login_qr_create())?;
            *qr_key.lock().map_err(|_| anyhow::anyhow!("login state unavailable"))? = Some(key.clone());
            Ok(json!({ "url": url, "key": key, "image": format!("/api/login/qr/image?key={}", key) }))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "502 Bad Gateway", json!({"error": e.to_string()}), head) }
        return;
    }
    if path == "/api/login/qr/image" {
        let key = query_param(query, "key").or_else(|| qr_key.lock().ok().and_then(|k| k.clone()));
        let Some(key) = key else { response(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", b"missing qr key", head); return; };
        let url = format!("https://music.163.com/login?codekey={key}");
        match qrcode_generator::to_png_to_vec_from_str(&url, qrcode_generator::QrCodeEcc::Low, 220) {
            Ok(bytes) => response(&mut stream, "200 OK", "image/png", &bytes, head),
            Err(error) => response(&mut stream, "502 Bad Gateway", "text/plain; charset=utf-8", error.to_string().as_bytes(), head),
        }
        return;
    }
    if path == "/api/login/qr/check" {
        let key = query_param(query, "key").or_else(|| qr_key.lock().ok().and_then(|k| k.clone()));
        let Some(key) = key else { json_response(&mut stream, "400 Bad Request", json!({"error":"缺少二维码 key"}), head); return; };
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let msg = glib::MainContext::default().block_on(guard.client.login_qr_check(key.clone()))?;
            // QR polling uses NetEase's 803 code for a confirmed login
            // (800 expired, 801 waiting for scan, 802 waiting for confirm).
            if msg.code == 803 {
                guard.save_cookie_jar_to_file();
                if let Ok(mut state) = qr_key.lock() { *state = None; }
            }
            Ok(json!({ "code": msg.code, "message": msg.msg, "loggedIn": msg.code == 803 }))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "502 Bad Gateway", json!({"error": e.to_string()}), head) }
        return;
    }
    if path == "/api/login/status" {
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let info = glib::MainContext::default().block_on(guard.client.login_status())?;
            Ok(json!({"code": info.code, "uid": info.uid, "nickname": info.nickname, "avatar": secure_url(&info.avatar_url), "message": info.msg, "loggedIn": info.code == 200 && info.uid > 0}))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "502 Bad Gateway", json!({"error": e.to_string(), "loggedIn": false}), head) }
        return;
    }
    if path == "/api/login" && method == "POST" {
        let (username, password) = if body.trim_start().starts_with('{') {
            let parsed: Value = serde_json::from_str(body).unwrap_or_default();
            (parsed.get("username").and_then(Value::as_str).unwrap_or_default().to_owned(), parsed.get("password").and_then(Value::as_str).unwrap_or_default().to_owned())
        } else { (form_param(body, "username").unwrap_or_default(), form_param(body, "password").unwrap_or_default()) };
        if username.is_empty() || password.is_empty() { json_response(&mut stream, "400 Bad Request", json!({"error":"请输入账号和密码"}), head); return; }
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let info = glib::MainContext::default().block_on(guard.client.login(username, password))?;
            if info.code == 200 { guard.save_cookie_jar_to_file(); }
            Ok(json!({"code": info.code, "uid": info.uid, "nickname": info.nickname, "avatar": secure_url(&info.avatar_url), "message": info.msg, "loggedIn": info.code == 200}))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "401 Unauthorized", json!({"error": e.to_string(), "loggedIn": false}), head) }
        return;
    }
    if (path == "/api/login/captcha" || path == "/api/login/cellphone") && method == "POST" {
        let parsed: Value = if body.trim_start().starts_with('{') { serde_json::from_str(body).unwrap_or_default() } else { Value::Null };
        let get = |name: &str| parsed.get(name).and_then(Value::as_str).map(str::to_owned).or_else(|| form_param(body, name));
        let ctcode = get("ctcode").unwrap_or_else(|| "86".to_owned());
        let phone = get("phone").unwrap_or_default();
        if phone.is_empty() { json_response(&mut stream, "400 Bad Request", json!({"error":"请输入手机号"}), head); return; }
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            if path == "/api/login/captcha" {
                glib::MainContext::default().block_on(guard.client.captcha(ctcode, phone))?;
                Ok(json!({"sent": true}))
            } else {
                let captcha = get("captcha").unwrap_or_default();
                if captcha.is_empty() { anyhow::bail!("请输入验证码"); }
                let info = glib::MainContext::default().block_on(guard.client.login_cellphone(ctcode, phone, captcha))?;
                if info.code == 200 { guard.save_cookie_jar_to_file(); }
                Ok(json!({"code": info.code, "uid": info.uid, "nickname": info.nickname, "avatar": secure_url(&info.avatar_url), "message": info.msg, "loggedIn": info.code == 200}))
            }
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "401 Unauthorized", json!({"error": e.to_string()}), head) }
        return;
    }
    if matches!(path, "/api/user/playlists" | "/api/playlists/mine" | "/api/favorites/playlists") {
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let info = glib::MainContext::default().block_on(guard.client.login_status())?;
            if info.uid == 0 { anyhow::bail!("请先登录"); }
            let lists = glib::MainContext::default().block_on(guard.client.user_song_list(info.uid, 0, 100))?;
            Ok(json!({"playlists": lists.iter().map(playlist_json).collect::<Vec<_>>(), "uid": info.uid}))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "401 Unauthorized", json!({"error": e.to_string()}), head) }
        return;
    }
    let lyric_id = path
        .strip_prefix("/api/song/")
        .and_then(|v| v.strip_suffix("/lyrics"))
        .or_else(|| path.strip_prefix("/api/lyrics/"))
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0);
    if let Some(id) = lyric_id {
        let call = || -> anyhow::Result<Value> {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let lyr = glib::MainContext::default().block_on(guard.client.song_lyric(id))?;
            Ok(json!({"id": id, "lyrics": lyr.lyric, "translation": lyr.tlyric}))
        };
        match call() { Ok(v) => json_response(&mut stream, "200 OK", v, head), Err(e) => json_response(&mut stream, "502 Bad Gateway", json!({"error": e.to_string()}), head) }
        return;
    }
    if path == "/api/search" {
        let search_query = query_param(query, "q").unwrap_or_default();
        let offset = query_param(query, "offset");
        let invalid_offset = offset.as_deref().is_some_and(|value| value.parse::<u16>().is_err());
        if search_query.is_empty() || search_query.len() > 100 || invalid_offset {
            json_response(&mut stream, "400 Bad Request", json!({ "error": "请输入有效关键词和分页参数" }), head);
            return;
        }
    }

    // Run the existing async client on a GLib context, as the desktop app does.
    let call = || -> anyhow::Result<Value> {
        if path == "/api/discover" {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let lists = glib::MainContext::default().block_on(guard.client.recommend_resource())?;
            return Ok(json!({ "playlists": lists.iter().map(playlist_json).collect::<Vec<_>>() }));
        }
        if path == "/api/search" {
            let q = query_param(query, "q").unwrap_or_default();
            let offset_value = query_param(query, "offset");
            let offset = match offset_value.as_deref() {
                None | Some("") => 0,
                Some(value) => value.parse::<u16>().map_err(|_| anyhow::anyhow!("分页参数无效"))?,
            };
            if q.is_empty() || q.len() > 100 {
                anyhow::bail!("请输入 1–100 字的关键词");
            }
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let songs = glib::MainContext::default().block_on(guard.client.search_song(q, offset, 30))?;
            return Ok(json!({ "songs": songs.iter().map(song_json).collect::<Vec<_>>(), "total": songs.len() }));
        }
        if let Some(id) = path.strip_prefix("/api/playlist/").and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0) {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let detail: PlayListDetail = glib::MainContext::default().block_on(guard.client.song_list_detail(id))?;
            return Ok(json!({
                "id": detail.id,
                "name": detail.name,
                "cover": secure_url(&detail.cover_img_url),
                "description": detail.description,
                "count": detail.songs.len(),
                "songs": detail.songs.iter().map(song_json).collect::<Vec<_>>(),
            }));
        }
        if let Some(id) = path.strip_prefix("/api/song/").and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0) {
            let guard = client.lock().map_err(|_| anyhow::anyhow!("client unavailable"))?;
            let urls = glib::MainContext::default().block_on(guard.songs_url(&[id], 2))?;
            let url = urls.first().map(|item| secure_url(&item.url)).unwrap_or_default();
            if url.is_empty() {
                anyhow::bail!("这首歌暂时无法播放");
            }
            return Ok(json!({ "url": url }));
        }
        anyhow::bail!("not found")
    };

    match call() {
        Ok(value) => json_response(&mut stream, "200 OK", value, head),
        Err(error) if error.to_string() == "not found" => {
            let asset = match path {
                "/" => Some((INDEX_HTML, "text/html; charset=utf-8")),
                "/app.js" => Some((APP_JS, "text/javascript; charset=utf-8")),
                "/player-state.js" => Some((PLAYER_STATE_JS, "text/javascript; charset=utf-8")),
                "/style.css" => Some((STYLE_CSS, "text/css; charset=utf-8")),
                _ => None,
            };
            if let Some((body, content_type)) = asset {
                response(&mut stream, "200 OK", content_type, body, head);
            } else {
                response(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"not found", head);
            }
        }
        Err(error) => json_response(&mut stream, "502 Bad Gateway", json!({ "error": error.to_string() }), head),
    }
}

pub fn run() -> anyhow::Result<()> {
    crate::path::init()?;
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("PORT").ok().and_then(|v| v.parse::<u16>().ok()).unwrap_or(3000);
    let listener = TcpListener::bind((host.as_str(), port))?;
    let client = NcmClient::load_cookie_jar_from_file()
        .map(NcmClient::from_cookie_jar)
        .unwrap_or_else(NcmClient::new);
    let client = Arc::new(Mutex::new(client));
    let qr_key = Arc::new(Mutex::new(None));
    println!("Music server: http://{host}:{port}");
    for stream in listener.incoming().flatten() {
        run_request(stream, &client, &qr_key);
    }
    Ok(())
}
