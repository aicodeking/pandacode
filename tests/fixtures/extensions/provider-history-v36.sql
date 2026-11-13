-- Applied to the actual current (36) schema, without rewriting its DDL.
INSERT INTO projects(id,name,path) VALUES ('history-project','History project','/recorded/project');
INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,resume_id,reasoning_effort,task_description)
VALUES ('legacy-task','history-project','Legacy conversation','codex','gpt-recorded','full','idle',100,200,'native-resume-legacy','high','Keep legacy task'),
       ('extension-task','history-project','Extension conversation','sample.harness/agent','model/recorded','ask','idle',300,400,'native-resume-extension','low','Keep extension task');
INSERT INTO messages(id,session_id,role,content,created_at) VALUES
 (401,'legacy-task','user','Legacy prompt',101), (402,'legacy-task','assistant','Legacy answer',102),
 (403,'extension-task','user','Extension prompt',301), (404,'extension-task','assistant','Extension answer',302),
 (405,'extension-task','tool','Recorded tool output',303);
INSERT INTO task_usage_links(session_id,harness_id,created_at) VALUES ('extension-task','native-resume-extension',304);
