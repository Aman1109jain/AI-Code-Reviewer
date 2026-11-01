import { useState } from 'react';
import { Database, Users, UserCog, LogOut, ShieldCheck } from 'lucide-react';
import adminApi from '../../adminApi.js';
import DbManager from './DbManager.jsx';
import AdminUsers from './AdminUsers.jsx';
import AdminAccount from './AdminAccount.jsx';

const TABS = [
  { key: 'db', label: 'Database', icon: Database },
  { key: 'admins', label: 'Admins', icon: Users },
  { key: 'account', label: 'My account', icon: UserCog },
];

export default function AdminConsole({ admin, onSignedOut }) {
  const [tab, setTab] = useState('db');
  const [me, setMe] = useState(admin);

  return (
    <div className="adm-console">
      <div className="panel-header-plain adm-console-head">
        <div>
          <h2><ShieldCheck size={20} /> Admin console</h2>
          <p>Signed in as <b>{me.username}</b> <span className={`badge adm-role adm-role-${me.role}`}>{me.role}</span></p>
        </div>
        <button className="btn-ghost-sm" onClick={async () => { await adminApi.logout().catch(() => {}); await onSignedOut(); }}>
          <LogOut size={14} /> Sign out
        </button>
      </div>

      <div className="adm-tabs" role="tablist">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`adm-tab ${tab === key ? 'is-active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'db' && <DbManager />}
      {tab === 'admins' && <AdminUsers me={me} />}
      {tab === 'account' && <AdminAccount me={me} onChanged={setMe} />}
    </div>
  );
}
