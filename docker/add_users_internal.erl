#!/usr/bin/env escript
%%! -noshell
main(_) ->
    %% 启动必要的 applications
    ok = application:start(mnesia),
    %% 等待 mnesia 启动
    timer:sleep(500),
    %% 创建 schema（如果不存在）
    case mnesia:create_table(emqx_authn_mnesia, [
        {attributes, record_info(fields, emqx_authn_mnesia)},
        {disc_copies, [node()]}
    ]) of
        {atomic, ok} -> io:format("Table created~n");
        {aborted, {already_exists, _}} -> io:format("Table exists~n");
        {aborted, Reason} -> io:format("Table error: ~p~n", [Reason])
    end,
    %% 写入用户
    ok = mnesia:dirty_write({emqx_authn_mnesia,
        <<"st_server">>,
        <<"8d22c8df90fd266b76327dfbe12837ef">>,
        <<"password">>,
        erlang:system_time(second),
        true}),
    io:format("st_server created~n"),
    ok = mnesia:dirty_write({emqx_authn_mnesia,
        <<"sht_device">>,
        <<"shutong-mqtt-2024">>,
        <<"password">>,
        erlang:system_time(second),
        true}),
    io:format("sht_device created~n"),
    init:stop().
