/*
 * Roda em segundo plano no APK (Capacitor Background Runner), sem a WebView.
 * A cada ~30 minutos pergunta ao servidor se há novidades (metas e lançamentos do banco)
 * e mostra cada uma como notificação do Android. Guarda só o endereço do servidor e a chave
 * de notificações, que só consegue ler /api/notifications.
 */

function read(key) {
  try {
    const v = CapacitorKV.get(key);
    if (v == null) return null;
    return typeof v === 'string' ? v : v.value || null;
  } catch (e) {
    return null;
  }
}

function show(list) {
  if (!list.length) return;
  CapacitorNotifications.schedule(
    list.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      largeBody: n.body,
      autoCancel: true,
      smallIcon: 'ic_stat_saldo'
    }))
  );
}

addEventListener('saldoCheck', async (resolve) => {
  try {
    const server = read('server');
    const token = read('token');
    if (!server || !token) return resolve();
    const res = await fetch(server + '/api/notifications', { headers: { authorization: 'Bearer ' + token } });
    if (res.status === 401 || res.status === 403) {
      // Chave revogada: para de perguntar até o app configurar de novo.
      CapacitorKV.remove('token');
      return resolve();
    }
    if (!res.ok) return resolve();
    const data = await res.json();
    show(data.notifications || []);
    resolve();
  } catch (e) {
    resolve();
  }
});

addEventListener('saldoConfigure', (resolve, reject, args) => {
  try {
    CapacitorKV.set('server', String(args.server));
    CapacitorKV.set('token', String(args.token));
    resolve();
  } catch (e) {
    reject(e);
  }
});

addEventListener('saldoDisable', (resolve) => {
  try {
    CapacitorKV.remove('token');
  } catch (e) {
    /* nada guardado */
  }
  resolve();
});

addEventListener('saldoTest', (resolve) => {
  show([{ id: 7, title: 'Saldo', body: 'As notificações estão ligadas. Você vai receber os avisos de meta e o que entrar do banco.' }]);
  resolve();
});
