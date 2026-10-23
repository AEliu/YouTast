// Offline fixtures explicitly opt out of pacing. Never use for real downloads.
export async function fastExecution(origin,cookie) {
 if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))throw new Error('Offline execution fixture requires localhost');
 const r=await fetch(origin+'/api/execution-policy',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({concurrency:3,start_interval:0,request_interval:0,download_wait:0,cooldown_seconds:60,paused:false})});
 const prefs=await fetch(origin+'/api/settings',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({settings:{audio_mode:'mp3'}})});
 if(!prefs.ok)throw new Error('Could not configure legacy MP3 regression fixture');
 if(!r.ok)throw new Error('Could not configure offline execution fixture');
}
