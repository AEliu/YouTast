// Backdrop hit-testing also distinguishes a drag that began inside the dialog.
export function outsideDialog(rect,x,y){return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;}
export function installDialogDismiss(dialog,closeButton,confirmDiscard=message=>window.confirm(message)){
 const form=dialog.querySelector('form');
 const snapshot=()=>JSON.stringify([...form.elements].filter(e=>e.name&&!['button','submit','reset'].includes(e.type)).map(e=>[e.name,e.type==='checkbox'||e.type==='radio'?e.checked:e.value]));
 let baseline=null,busy=false,pointerOutside=false,generation=0;
 const canLeave=()=>!busy&&(baseline===null||snapshot()===baseline||confirmDiscard('有尚未保存的修改，确定放弃并关闭吗？'));
 const requestClose=()=>{if(canLeave())dialog.close();};
 closeButton.addEventListener('click',requestClose);
 dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
 dialog.addEventListener('pointerdown',event=>{pointerOutside=event.button===0&&event.target===dialog&&outsideDialog(dialog.getBoundingClientRect(),event.clientX,event.clientY);});
 dialog.addEventListener('pointercancel',()=>{pointerOutside=false;});
 dialog.addEventListener('click',event=>{const dismiss=pointerOutside&&event.target===dialog&&outsideDialog(dialog.getBoundingClientRect(),event.clientX,event.clientY);pointerOutside=false;if(dismiss)requestClose();});
 dialog.addEventListener('close',()=>{if(!dialog.open){baseline=null;busy=false;closeButton.disabled=false;}});
 return {canLeave,reset(){baseline=snapshot();busy=false;closeButton.disabled=false;return ++generation;},setBusy(value){busy=value;closeButton.disabled=value;},get generation(){return generation;}};
}
