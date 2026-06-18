#!/usr/bin/env escript
%%! -noshell
main(_) ->
    P1 = <<>>,
    P2 = <<>>,
    ok = mnesia:dirty_write({emqx_authn_mnesia, <<"st_server">>, P1, <<"st_server">>, erlang:system_time(second), true}),
    io:format("st_server done~n"),
    ok = mnesia:dirty_write({emqx_authn_mnesia, <<"sht_device">>, P2, <<"sht_device">>, erlang:system_time(second), true}),
    io:format("sht_device done~n"),
    init:stop().
