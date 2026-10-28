using Xunit;

public class GreeterTests
{
    [Fact]
    public void HelloGreetsByName() => Assert.Equal("hello, proj", {{module}}.Greeter.Hello("proj"));
}
