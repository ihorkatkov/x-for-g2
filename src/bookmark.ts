import type {Mode} from './model.ts'
/** Confirmation belongs to the captured account/post, never a later selection.
 * Nothing is optimistically marked saved; uncertain writes are never retried. */
export class BookmarkAction {
 private pendingKey=''
 private pendingMode:Mode='live'
 private states=new Map<string,{saved:boolean;message:string}>()
 private alive=true
 constructor(private send:(id:string,scope:string,mode:Mode)=>Promise<void>,private changed:()=>void){}
 private key(id:string,scope:string){return scope+':'+id}
 status(id:string,scope:string){const key=this.key(id,scope);return this.pendingKey===key?{saved:false,message:this.pendingMode==='demo'?'Saving demo':'Saving to X'}:this.states.get(key)??{saved:false,message:''}}
 get busy(){return !!this.pendingKey}
 async save(id:string,scope:string,mode:Mode){
  const key=this.key(id,scope);
  if(!this.alive||this.busy||this.states.get(key)?.saved)return;
  this.pendingMode=mode;this.pendingKey=key;this.changed();
  let result;
  try{await this.send(id,scope,mode);result={saved:true,message:mode==='demo'?'Demo saved':'Saved to X'}}
  catch(error){result={saved:false,message:error instanceof Error?error.message:'Check X bookmarks'}}
  if(!this.alive)return;
  if(this.states.size>=100)this.states.delete(this.states.keys().next().value!);
  this.states.set(key,result);this.pendingKey='';this.changed();
 }
 dispose(){this.alive=false}
}
