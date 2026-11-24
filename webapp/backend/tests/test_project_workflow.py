"""Business API integration test. No OCR/YOLO process is launched."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import main, business_store as store, analysis_jobs as jobs


async def request(method, path, payload=None, token=None, pdf=None):
    headers = []
    if token: headers.append((b'authorization', ('Bearer '+token).encode()))
    if pdf is not None:
        body = b'--qa\r\nContent-Disposition: form-data; name="file"; filename="qa.pdf"\r\nContent-Type: application/pdf\r\n\r\n'+pdf+b'\r\n--qa--\r\n'
        headers.append((b'content-type', b'multipart/form-data; boundary=qa'))
    else:
        body = json.dumps(payload).encode() if payload is not None else b''
        headers.append((b'content-type', b'application/json'))
    headers.append((b'content-length',str(len(body)).encode()))
    sent = False; messages = []
    async def receive():
        nonlocal sent
        if not sent:
            sent=True
            return {'type':'http.request','body':body,'more_body':False}
        await asyncio.sleep(3600)
    async def send(message): messages.append(message)
    await main.app({'type':'http','asgi':{'version':'3.0','spec_version':'2.4'},'http_version':'1.1','scheme':'http','method':method,'path':path,'raw_path':path.encode(),'query_string':b'','root_path':'','headers':headers,'server':('localhost',8000),'client':('127.0.0.1',1)},receive,send)
    status=next(m['status'] for m in messages if m['type']=='http.response.start')
    raw=b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body')
    try: return status,json.loads(raw)
    except (ValueError,UnicodeDecodeError): return status,raw


class WorkflowTest(unittest.TestCase):
    def test_roles_documents_jobs_and_artifacts(self):
        with tempfile.TemporaryDirectory(prefix='pfd-business-qa-') as folder:
            root=Path(folder); runtime=root/'webapp/runtime'; runtime.mkdir(parents=True)
            with patch.object(store,'DB_PATH',runtime/'qa.sqlite'), patch.object(store,'SECRET_PATH',runtime/'secret'), patch.object(main,'PROJECT_ROOT',root), patch.object(jobs,'PROJECT_ROOT',root), patch.object(jobs,'JOBS_ROOT',runtime/'analyses'), patch.object(main,'start_analysis_job') as worker:
                store.init_db()
                def call(method,path,payload=None,token=None,pdf=None): return asyncio.run(request(method,path,payload,token,pdf))
                def ok(method,path,payload=None,token=None,pdf=None):
                    code,data=call(method,path,payload,token,pdf); self.assertEqual(code,200,data); return data
                admin=ok('POST','/api/auth/login',{'email':'admin@jesa.local','password':'Admin123!'})['access_token']
                user=ok('POST','/api/users',{'name':'QA User','email':'qa@example.test','password':'Testing123!','role':'user'},admin)
                self.assertNotIn('password_hash',user)
                project=ok('POST','/api/projects',{'name':'QA assigned','description':'Workflow'},admin)
                other=ok('POST','/api/projects',{'name':'QA private'},admin)
                ok('POST',f"/api/projects/{project['id']}/users/{user['id']}",token=admin)
                ok('POST','/api/auth/logout',token=admin)
                token=ok('POST','/api/auth/login',{'email':'qa@example.test','password':'Testing123!'})['access_token']
                self.assertEqual([p['id'] for p in ok('GET','/api/projects',token=token)['items']],[project['id']])
                self.assertEqual(call('POST','/api/projects',{'name':'Forbidden'},token)[0],403)
                self.assertEqual(call('GET',f"/api/projects/{other['id']}",token=token)[0],404)
                self.assertEqual(call('GET','/api/projects')[0],401)
                self.assertEqual(call('GET','/api/analyses/analysis-orphan',token=token)[0],404)
                self.assertEqual(call('POST','/api/analyze',token=token,pdf=b'%PDF-1.4\n%%EOF')[0],410)
                upload=ok('POST',f"/api/projects/{project['id']}/pfds",token=token,pdf=b'%PDF-1.4\n%%EOF')
                doc=upload['pfd']; self.assertIsNone(doc['analysis_id']); worker.assert_not_called()
                self.assertEqual(doc['status'],'not_analyzed')
                self.assertEqual(len(ok('GET',f"/api/projects/{project['id']}/pfds",token=token)['items']),1)
                job=ok('POST',f"/api/pfds/{doc['id']}/analyze",token=token); aid=job['analysis_id']
                worker.assert_called_once_with(aid)
                self.assertEqual(job['pfd_id'],doc['id']); self.assertEqual(job['project_id'],project['id'])
                detail=ok('GET',f"/api/projects/{project['id']}",token=token)
                self.assertEqual(detail['status'],'active'); self.assertEqual(detail['created_by_name'],'Administrateur JESA')
                self.assertEqual(detail['member_count'],2); self.assertEqual(detail['pfd_count'],1)
                self.assertEqual(detail['analysis_counts'],{'completed':0,'running':1,'failed':0})
                listed_doc=ok('GET',f"/api/projects/{project['id']}/pfds",token=token)['items'][0]
                self.assertIsNotNone(listed_doc['last_analysis_at'])
                # Simulate worker state only; this is not an inference-quality test.
                for state in ['rendering_pdf','running_ocr','running_yolo','associating']:
                    jobs.update_job(aid,status=state,worker_started=True)
                    self.assertEqual(ok('GET','/api/analyses/'+aid,token=token)['status'],state)
                directory=jobs.job_dir(aid)
                def write(name,value):
                    path=directory/name; path.write_text(json.dumps(value),encoding='utf-8'); return str(path)
                outputs={'ocr_json':write('ocr.json',{'items':[{'text':'QA','confidence':0.9}]}),'yolo_detections':write('yolo.json',{'detections':[{'class':'pump'}],'inference':{'final_detection_count':1}}),'associations':write('associations.json',{'associations':[{'status':'associated'}]})}
                write('stage10_perception_manifest.json',{'outputs':outputs,'scope':'QA fixture'})
                jobs.update_job(aid,status='completed')
                detail=ok('GET',f"/api/projects/{project['id']}",token=token)
                self.assertEqual(detail['analysis_counts'],{'completed':1,'running':0,'failed':0})
                result=ok('GET',f'/api/analyses/{aid}/results',token=token)
                self.assertEqual(result['ocr']['items'][0]['text'],'QA'); self.assertEqual(len(result['detections']),1)
                self.assertEqual(result['associations'][0]['status'],'associated'); self.assertFalse(result['validated_graph']['available'])
                artifact=result['artifacts']['ocr_json']; self.assertEqual(ok('GET',artifact,token=token)['items'][0]['text'],'QA')
                self.assertEqual(call('GET',artifact)[0],401)
                second=ok('POST',f"/api/projects/{other['id']}/pfds",token=admin,pdf=b'%PDF-1.4\n%%EOF')['pfd']
                second_job=ok('POST',f"/api/pfds/{second['id']}/analyze",token=admin)
                self.assertNotEqual(second_job['analysis_id'],aid)
                self.assertEqual(store.pfd_for_analysis(aid)['id'],doc['id'])
                self.assertEqual(call('GET',f"/api/analyses/{second_job['analysis_id']}",token=token)[0],404)
                self.assertEqual(call('GET',f"/analysis-files/{second_job['analysis_id']}/job.json",token=token)[0],404)
                self.assertEqual(call('POST',f"/api/pfds/{second['id']}/analyze",token=token)[0],404)
                self.assertEqual(call('DELETE',f"/api/projects/{project['id']}",token=admin)[0],409)
                overview=ok('GET','/api/workspace',token=token)
                self.assertEqual(overview['projects'],1); self.assertEqual(overview['completed'],1)
                print('PASS: roles, project membership, upload without job, contextual analysis, states, results, protected artifacts, duplicate upload isolation; worker simulated.')


if __name__=='__main__': unittest.main()
