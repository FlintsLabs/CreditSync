// Read-only recovery gate. Never imports services, repairs rows, or logs identifiers.
import postgres from 'postgres';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {createHash} from 'node:crypto';
import {inspectRecovery,type Reference,type ObjectState} from './evidence-recovery-policy';
if(!process.env.DATABASE_URL || !process.env.S3_ENDPOINT) throw new Error('Explicit database and storage endpoints required');
const db=postgres(process.env.DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on'}});
const s3=new S3Client({region:'us-east-1',endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:process.env.MINIO_ROOT_USER!,secretAccessKey:process.env.MINIO_ROOT_PASSWORD!}});
const counts:Record<string,number>={};
const count=(key:string)=>counts[key]=(counts[key]??0)+1;
const pendingTables=new Set(['payment_evidence','payment_batch_staging_evidence','loan_disbursement_evidence_intents','intermediated_transfer_evidence_intents','intermediary_remittance_evidence_intents','borrower_id_card_upload_intents']);
try {
await db.begin('isolation level repeatable read read only',async sql=>{
const references=new Map<number,Array<Reference & {identity:string}>>();
const columns=await sql`select table_name,column_name from information_schema.columns where table_schema='public' and (column_name='file_id' or right(column_name,8)='_file_id') order by table_name,column_name`;
for(const c of columns){
const rows=await sql.unsafe(`select id, "${c.column_name}" as file_id, to_jsonb(t)->>'status' as status, to_jsonb(t)->>'evidence_hash' as hash from public."${c.table_name}" t`);
for(const r of rows){
const pending=pendingTables.has(c.table_name)&&r.status==='pending';
if(r.file_id===null){if(!pending&&r.status==='ready')count('missing_file_reference');continue;}
const list=references.get(r.file_id)??[];
list.push({pending,hash:r.hash??undefined,identity:`${c.table_name}:${r.id}`});references.set(r.file_id,list);
}
}
const metadata=new Map<string,Record<string,string>[]>();
const add=(id:string,candidate:Record<string,string>)=>metadata.set(id,[...(metadata.get(id)??[]),candidate]);
for(const table of ['payment_evidence','payment_evidence_supplements']) {
const rows=await sql.unsafe(`select e.id,e.tenant_id,i.public_id from ${table} e join payment_intakes i on i.id=e.payment_intake_id and i.tenant_id=e.tenant_id where e.status in ('ready','recorded')`);
for(const r of rows)add(`${table}:${r.id}`,{tenant:r.tenant_id,intake:r.public_id});
}
const staged=await sql`select e.id,e.tenant_id,s.public_id,p.id as payment_id from payment_batch_staging_evidence e join payment_batch_staging_items s on s.id=e.staging_item_id and s.tenant_id=e.tenant_id left join payment_evidence p on p.payment_intake_id=s.payment_intake_id and p.tenant_id=e.tenant_id and p.file_id=e.file_id and p.status='ready' and p.evidence_hash=e.evidence_hash where e.status='ready' and (s.payment_intake_id is null or p.id is not null)`;
for(const r of staged){add(`payment_batch_staging_evidence:${r.id}`,{tenant:r.tenant_id,staging:r.public_id});if(r.payment_id!==null)add(`payment_evidence:${r.payment_id}`,{tenant:r.tenant_id,staging:r.public_id});}
for(const [table,parent,fk,key] of [
['loan_disbursement_evidence_intents','loan_disbursement_events','loan_disbursement_event_id','disbursement'],
['intermediary_remittance_evidence_intents','intermediary_remittances','remittance_id','remittance'],
] as const){
const rows=await sql.unsafe(`select e.id,e.tenant_id,p.public_id from ${table} e join ${parent} p on p.id=e.${fk} and p.tenant_id=e.tenant_id where e.status='ready'`);
for(const r of rows)add(`${table}:${r.id}`,{tenant:r.tenant_id,[key]:r.public_id});
}
const transfers=await sql`select e.id,e.tenant_id,t.public_id as event,g.public_id as group from intermediated_transfer_evidence_intents e join intermediated_transfer_events t on t.id=e.event_id and t.tenant_id=e.tenant_id join intermediated_disbursement_groups g on g.id=t.group_id and g.tenant_id=e.tenant_id where e.status='ready'`;
for(const r of transfers)add(`intermediated_transfer_evidence_intents:${r.id}`,{tenant:r.tenant_id,event:r.event,group:r.group});
const files=await sql`select id,bucket,key,mime_type,size from files order by id`;
const fileIds=new Set(files.map(f=>f.id));
for(const id of references.keys())if(!fileIds.has(id))count('dangling_file_reference');
for(const f of files){
const refs=(references.get(f.id)??[]).map(r=>({...r,metadata:r.hash?metadata.get(r.identity):undefined}));
let object:ObjectState={exists:false};
try {
const stored=await s3.send(new GetObjectCommand({Bucket:f.bucket,Key:f.key}));
const hash=createHash('sha256');let size=0;
for await(const chunk of stored.Body as AsyncIterable<Uint8Array>){size+=chunk.byteLength;hash.update(chunk);}
object={exists:true,mime:stored.ContentType,size,hash:hash.digest('hex'),metadata:stored.Metadata};
}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404){count('storage_request_error');continue;}}
const result=inspectRecovery({mime:f.mime_type,size:f.size},refs,object);
count(result);
if(result==='pending_warning'){if(!object.exists)count('pending_missing');else if(object.mime!==f.mime_type)count('pending_mime_mismatch');}
}
});
const warnings=new Set(['pass','pending_warning','pending_missing','pending_mime_mismatch']);
const failed=Object.keys(counts).some(key=>!warnings.has(key));
console.log(JSON.stringify({status:failed?'failed':'pass',readOnly:true,counts},null,2));
if(failed)process.exitCode=1;
}catch {console.error(JSON.stringify({status:'failed',category:'recovery_check_error'}));process.exitCode=1;}
finally{await db.end();s3.destroy();}
