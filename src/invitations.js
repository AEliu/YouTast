import {hash,id,now} from './lib.js';

// Preserve the original deployment invitation, while making it manageable.
// INSERT OR IGNORE never re-enables or resets an invitation after admin edits.
export async function seedLegacyInvite(env) {
 if(!env.REGISTRATION_INVITE)return;
 await env.DB.prepare(`INSERT OR IGNORE INTO invitations(id,code_hash,hint,label,max_uses,legacy,created_at)
 VALUES(?,?,'原有口令','原有邀请口令',0,1,?)`).bind(id(),await hash(env.REGISTRATION_INVITE),now()).run();
}
