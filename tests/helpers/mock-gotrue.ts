import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * テスト専用の、Supabase Auth（GoTrue）の代わりの小さなサーバー。本物のSupabaseには一切接続しない。
 *
 * メールの送信はせず、「メールのリンクを開いた」ときにSupabaseが返す戻り先のURLを、テストが作れるようにする
 * （confirmLinkFor・recoveryLinkFor）。会員登録・ログイン・パスワード再設定・パスワード変更・他端末のログアウトに
 * 必要な分だけを、本物と同じ形の応答で返す。
 */

type User = { id: string; email: string; password: string; confirmed: boolean; username: string };
type Pending = { userId: string; challenge: string | null; redirectTo: string };

function b64url(value: object | string): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/** このサーバーが受け付けるメールアドレスの末尾。それ以外（同時に動く別のテスト）には応答しない */
export const MOCK_EMAIL_DOMAIN = "@mock-gotrue.test";

export class MockGoTrue {
  private server: http.Server | null = null;
  users = new Map<string, User>();
  /** メール確認のリンク（まだ開いていないもの） */
  private signupLinks = new Map<string, Pending>();
  /** パスワード再設定のリンク（まだ開いていないもの） */
  private recoveryLinks = new Map<string, Pending>();
  /** 確認のあとに発行した認可コード（1回だけ使える） */
  private codes = new Map<string, { userId: string; challenge: string }>();
  private accessTokens = new Map<string, string>();
  private refreshTokens = new Map<string, string>();
  /** パスワード再設定の申し込みの記録（PKCEの値が付いていたか） */
  recoverRequests: { email: string; hasCodeChallenge: boolean; redirectTo: string }[] = [];
  /** 他端末のログアウト（scope=others）が呼ばれた回数 */
  logoutOthers = 0;

  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          this.handle(req, res, raw ? JSON.parse(raw) : {});
        } catch {
          this.send(res, 500, { code: "unexpected_failure", msg: "mock error" });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** 確認メールのリンクを開いたとき：メールアドレスを確認済みにして、戻り先（?code=）を返す。2回目以降は期限切れのエラー */
  confirmLinkFor(email: string): string {
    const pending = this.signupLinks.get(email);
    if (!pending) return `${this.lastSignupRedirect.get(email)}?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`;
    this.signupLinks.delete(email);
    const user = this.users.get(email)!;
    user.confirmed = true;
    const code = randomUUID();
    this.codes.set(code, { userId: user.id, challenge: pending.challenge ?? "" });
    return `${pending.redirectTo}?code=${code}`;
  }

  /** 再設定メールのリンクを開いたとき：implicit なら #access_token、PKCE なら ?code を付けた戻り先。2回目以降は期限切れのエラー */
  recoveryLinkFor(email: string): string {
    const pending = this.recoveryLinks.get(email);
    if (!pending) return `${this.lastRecoveryRedirect.get(email)}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`;
    this.recoveryLinks.delete(email);
    if (pending.challenge) {
      const code = randomUUID();
      this.codes.set(code, { userId: pending.userId, challenge: pending.challenge });
      return `${pending.redirectTo}?code=${code}`;
    }
    const s = this.issueSession(pending.userId);
    return `${pending.redirectTo}#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=recovery`;
  }

  private lastSignupRedirect = new Map<string, string>();
  private lastRecoveryRedirect = new Map<string, string>();

  private userJson(user: User) {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      email_confirmed_at: user.confirmed ? new Date().toISOString() : null,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { username: user.username },
      identities: [{ id: user.id, user_id: user.id, provider: "email", identity_data: { email: user.email } }],
      created_at: new Date().toISOString(),
    };
  }

  private issueSession(userId: string) {
    const now = Math.floor(Date.now() / 1000);
    const user = [...this.users.values()].find((u) => u.id === userId)!;
    const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: userId, aud: "authenticated", role: "authenticated", email: user.email, exp: now + 3600, iat: now, session_id: randomUUID() })}.${randomBytes(8).toString("hex")}`;
    const refresh = randomBytes(12).toString("hex");
    this.accessTokens.set(access, userId);
    this.refreshTokens.set(refresh, userId);
    return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: this.userJson(user) };
  }

  private userFromAuth(req: http.IncomingMessage): User | null {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const id = this.accessTokens.get(token);
    return id ? [...this.users.values()].find((u) => u.id === id) ?? null : null;
  }

  private send(res: http.ServerResponse, status: number, body?: object) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
    res.end(body ? JSON.stringify(body) : undefined);
  }

  private fail(res: http.ServerResponse, status: number, code: string, msg: string) {
    this.send(res, status, { code, error_code: code, msg, message: msg });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, string>) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    if (req.method === "OPTIONS") return this.send(res, 204);
    // 別のテストの会員登録・ログイン・再設定の申し込みには応答しない（「Supabaseに接続できない」のと同じ状態にする）
    if (typeof body.email === "string" && !body.email.endsWith(MOCK_EMAIL_DOMAIN)) return void req.socket.destroy();

    if (req.method === "POST" && path === "/auth/v1/signup") {
      const redirectTo = url.searchParams.get("redirect_to") ?? "";
      const id = randomUUID();
      const user: User = { id, email: body.email, password: body.password, confirmed: false, username: (body as unknown as { data?: { username?: string } }).data?.username ?? "" };
      this.users.set(body.email, user);
      this.signupLinks.set(body.email, { userId: id, challenge: body.code_challenge ?? null, redirectTo });
      this.lastSignupRedirect.set(body.email, redirectTo);
      return this.send(res, 200, this.userJson(user));
    }

    if (req.method === "POST" && path === "/auth/v1/recover") {
      const redirectTo = url.searchParams.get("redirect_to") ?? "";
      this.recoverRequests.push({ email: body.email, hasCodeChallenge: !!body.code_challenge, redirectTo });
      const user = this.users.get(body.email);
      if (user) {
        this.recoveryLinks.set(body.email, { userId: user.id, challenge: body.code_challenge ?? null, redirectTo });
        this.lastRecoveryRedirect.set(body.email, redirectTo);
      }
      return this.send(res, 200, {});
    }

    if (req.method === "POST" && path === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "pkce") {
        const entry = this.codes.get(body.auth_code);
        if (!entry) return this.fail(res, 404, "flow_state_not_found", "invalid flow state, no valid flow state found");
        const expected = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (expected !== entry.challenge) return this.fail(res, 400, "bad_code_verifier", "code challenge does not match previously saved code verifier");
        this.codes.delete(body.auth_code);
        return this.send(res, 200, this.issueSession(entry.userId));
      }
      if (grant === "password") {
        const user = this.users.get(body.email);
        if (!user || user.password !== body.password) return this.fail(res, 400, "invalid_credentials", "Invalid login credentials");
        if (!user.confirmed) return this.fail(res, 400, "email_not_confirmed", "Email not confirmed");
        return this.send(res, 200, this.issueSession(user.id));
      }
      if (grant === "refresh_token") {
        const id = this.refreshTokens.get(body.refresh_token);
        if (!id) return void req.socket.destroy();
        return this.send(res, 200, this.issueSession(id));
      }
      return this.fail(res, 400, "validation_failed", "unsupported grant_type");
    }

    if (path === "/auth/v1/user") {
      const user = this.userFromAuth(req);
      // このサーバーが発行していない値（同時に動く別のテストのログイン）には応答しない。
      // 応答すると、別のテストのログインのCookieが消されてしまうため、「Supabaseに接続できない」のと同じ状態にする
      if (!user) return void req.socket.destroy();
      if (req.method === "PUT") {
        if (typeof body.password === "string") {
          if (body.password === user.password) return this.fail(res, 422, "same_password", "New password should be different from the old password.");
          user.password = body.password;
        }
      }
      return this.send(res, 200, this.userJson(user));
    }

    if (req.method === "POST" && path === "/auth/v1/logout") {
      if (url.searchParams.get("scope") === "others") this.logoutOthers += 1;
      return this.send(res, 204);
    }

    // そのほか（DBの読み書きなど）は、空の結果を返す
    if (path.startsWith("/rest/v1/")) return this.send(res, 200, []);
    return this.fail(res, 404, "not_found", "not found");
  }
}
