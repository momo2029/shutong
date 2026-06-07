#!/bin/bash
# 检查 EMQX 认证模块 API
# 在 emqx 容器内执行

docker exec docker-emqx-1 sh -c '/opt/emqx/erts-13.2.2/bin/escript /tmp/check_api.erl' << 'EOF'
#!/usr/bin/env escript
%%! -noshell
main(_) ->
    %% 尝试直接调用内置 API
    %% EMQX 5.x 使用 emqx_authn_mnesia:put_user/1
    %% 检查模块是否存在
    case code:ensure_loaded(emqx_authn_mnesia) of
        {module, _} ->
            io:format("Module loaded~n"),
            Info = emqx_authn_mnesia:module_info(exports),
            io:format("Exports: ~p~n", [Info]);
        {error, Reason} ->
            io:format("Module load failed: ~p~n", [Reason])
    end,
    init:stop().
EOF
