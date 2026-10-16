import { useState, type FormEvent } from 'react';
import { api, ApiError, isNativeApp, serverStore, type User } from '../api';
import { useAuth } from '../auth';
import { useSlow, WAKING_MESSAGE } from '../useSlow';

type Mode = 'entrar' | 'criar';

export function LoginPage() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<Mode>('entrar');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const slow = useSlow(busy);
  const [server, setServer] = useState(serverStore.get());
  const [editServer, setEditServer] = useState(isNativeApp && !serverStore.get());

  async function go(path: string, body?: unknown) {
    if (isNativeApp) {
      if (!server.trim()) {
        setEditServer(true);
        setError('Informe o endereço do servidor para entrar.');
        return;
      }
      serverStore.set(server);
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const r = await api.post<{ token: string; user: User }>(path, body);
      signIn(r.token, r.user);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      } else setError('Algo deu errado.');
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'entrar') go('/auth/login', { email, password });
    else go('/auth/register', { name, email, password });
  };

  return (
    <div className="login">
      <section className="login-intro">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={56} height={56} />
        <h1>Saldo</h1>
        <p>Entradas, saídas e o que sobra no mês. Lance pelo celular em segundos e veja para onde o dinheiro está indo.</p>
        <div className="login-sample" aria-hidden="true">
          <span className="hero-label">Saldo do mês</span>
          <span className="sample-value tnum">R$ 1.482,30</span>
          <span className="regua">
            <span style={{ width: '72%' }} />
          </span>
          <span className="regua-caption">Saiu 72% do que entrou.</span>
        </div>
      </section>

      <section className="login-card">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'entrar'} className="seg" onClick={() => setMode('entrar')}>
            Entrar
          </button>
          <button role="tab" aria-selected={mode === 'criar'} className="seg" onClick={() => setMode('criar')}>
            Criar conta
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          {mode === 'criar' && (
            <label className="field">
              <span>Nome</span>
              <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(fieldErrors.name)} />
              {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
            </label>
          )}
          <label className="field">
            <span>E-mail</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              inputMode="email"
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
            />
            {fieldErrors.email && <small className="field-error">{fieldErrors.email}</small>}
          </label>
          <label className="field">
            <span>Senha</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === 'entrar' ? 'current-password' : 'new-password'}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(fieldErrors.password)}
            />
            {fieldErrors.password ? (
              <small className="field-error">{fieldErrors.password}</small>
            ) : (
              mode === 'criar' && <small className="muted">Pelo menos 8 caracteres.</small>
            )}
          </label>
          {error && !Object.keys(fieldErrors).length && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {slow && (
            <p className="muted" role="status">
              {WAKING_MESSAGE}
            </p>
          )}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Aguarde…' : mode === 'entrar' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        {isNativeApp && (
          <div className="server-field">
            {editServer ? (
              <label className="field">
                <span>Endereço do servidor</span>
                <input
                  type="url"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://saldo-api.onrender.com"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                />
                <small className="muted">O endereço da API publicada no Render, ou do seu PC na mesma rede Wi-Fi (http://192.168.x.x:3333).</small>
              </label>
            ) : (
              <p className="muted">
                Servidor: {server.replace(/^https?:\/\//, '')}{' '}
                <button type="button" className="link-btn inline" onClick={() => setEditServer(true)}>
                  Alterar
                </button>
              </p>
            )}
          </div>
        )}

        <div className="demo-cta">
          <p>Só quer conhecer?</p>
          <button className="btn block" disabled={busy} onClick={() => go('/auth/demo')}>
            Abrir a demonstração
          </button>
          <small className="muted">Cria uma conta temporária com quatro meses de dados fictícios.</small>
        </div>
      </section>
    </div>
  );
}
